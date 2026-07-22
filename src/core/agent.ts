// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The agent loop: input -> model -> tools -> answer.
 *
 * It depends on a model gateway, a session store and a tool registry, and
 * optionally an approval store. No provider, no database, no product domain —
 * that is what makes this file testable without a network and reusable by
 * every product built on the harness.
 *
 * When a tool marked `requiresApproval` comes up, the turn does not run it: the
 * agent records pending approvals and returns. The whole state of the pause is
 * in the session and the approval queue, so it costs nothing while it waits —
 * no process blocks. A later `resume` continues from there.
 */

import type { Approval, ApprovalStore } from '../approval/approval-store.js';
import type {
  ModelGateway,
  ModelMessage,
  ToolCallPart,
  TokenUsage,
  ToolResultPart,
} from '../models/model-gateway.js';
import { responseText, toolCalls } from '../models/model-gateway.js';
import type { SessionStore } from '../memory/session-store.js';
import { SessionNotFoundError } from '../memory/session-store.js';

import type { Persona } from './persona.js';
import type { ToolRegistry } from './tool.js';

export interface AgentDependencies {
  readonly gateway: ModelGateway;
  readonly sessions: SessionStore;
  readonly tools: ToolRegistry;
  readonly persona: Persona;
  /**
   * Where gated tool calls wait for a human. Without it, an approval-gated
   * tool fails closed — the agent refuses to run it — which keeps a product
   * that has not wired approval yet from running sensitive actions unchecked.
   */
  readonly approvals?: ApprovalStore;
}

export interface AgentTurn {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly input: string;
}

export interface ResumeInput {
  readonly tenantId: string;
  readonly sessionId: string;
}

/** One tool call and what it produced, kept for the trace. */
export interface ToolInvocation {
  readonly name: string;
  readonly input: unknown;
  readonly output: string;
  readonly isError: boolean;
}

export type StopReason =
  'end_turn' | 'max_tokens' | 'refusal' | 'iteration_limit' | 'awaiting_approval';

export interface AgentReply {
  readonly text: string;
  readonly toolInvocations: readonly ToolInvocation[];
  /** Model calls this turn took — one per loop iteration. */
  readonly modelCalls: number;
  readonly usage: TokenUsage;
  readonly stopReason: StopReason;
  /** Set when stopReason is 'awaiting_approval': the calls waiting on a human. */
  readonly pendingApprovals?: readonly Approval[];
}

export class AgentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentError';
  }
}

interface Context {
  readonly tenantId: string;
  readonly sessionId: string;
}

/** The two ways a tool-call turn resolves before the loop can continue. */
type Settlement =
  | { readonly status: 'ready'; readonly results: ToolResultPart[] }
  | { readonly status: 'awaiting'; readonly pending: Approval[] };

export class Agent {
  readonly #gateway: ModelGateway;
  readonly #sessions: SessionStore;
  readonly #tools: ToolRegistry;
  readonly #persona: Persona;
  readonly #approvals: ApprovalStore | undefined;

  constructor(dependencies: AgentDependencies) {
    this.#gateway = dependencies.gateway;
    this.#sessions = dependencies.sessions;
    this.#tools = dependencies.tools;
    this.#persona = dependencies.persona;
    this.#approvals = dependencies.approvals;
  }

  /**
   * Run one user turn.
   *
   * Every message produced — the user turn, each assistant turn, each tool
   * result — is appended to the session as it happens, so a restart mid-turn
   * loses the in-flight call but not the conversation. If a gated tool comes
   * up, the turn pauses and returns 'awaiting_approval'.
   */
  async run(turn: AgentTurn): Promise<AgentReply> {
    const ctx: Context = { tenantId: turn.tenantId, sessionId: turn.sessionId };
    await this.#requireSession(ctx);

    const userTurn: ModelMessage = { role: 'user', content: [{ type: 'text', text: turn.input }] };
    await this.#sessions.append(ctx.tenantId, ctx.sessionId, [userTurn]);

    const history = await this.#sessions.messages(ctx.tenantId, ctx.sessionId);
    return this.#drive(ctx, history, new UsageTotal(), []);
  }

  /**
   * Continue a turn that paused for approval.
   *
   * Reads the paused assistant turn, settles its tool calls against the
   * decisions taken, and drives on. If any gated call is still undecided, it
   * pauses again rather than running a half-approved turn.
   */
  async resume(input: ResumeInput): Promise<AgentReply> {
    const ctx: Context = { tenantId: input.tenantId, sessionId: input.sessionId };
    await this.#requireSession(ctx);

    const history: ModelMessage[] = await this.#sessions.messages(ctx.tenantId, ctx.sessionId);
    const last = history.at(-1);
    const calls =
      last && last.role === 'assistant'
        ? last.content.filter((part): part is ToolCallPart => part.type === 'tool_call')
        : [];

    if (calls.length === 0) {
      throw new AgentError('session is not awaiting approval: no paused tool call to resume');
    }

    const invocations: ToolInvocation[] = [];
    const settlement = await this.#settle(ctx, calls, invocations);
    if (settlement.status === 'awaiting') {
      return awaitingReply(settlement.pending);
    }

    const resultTurn: ModelMessage = { role: 'user', content: settlement.results };
    history.push(resultTurn);
    await this.#sessions.append(ctx.tenantId, ctx.sessionId, [resultTurn]);

    return this.#drive(ctx, history, new UsageTotal(), invocations);
  }

  /** The model → tools loop, shared by run and resume. */
  async #drive(
    ctx: Context,
    history: ModelMessage[],
    usage: UsageTotal,
    invocations: ToolInvocation[],
  ): Promise<AgentReply> {
    const toolSchemas = this.#tools.size > 0 ? this.#tools.schemas() : undefined;

    for (let iteration = 0; iteration < this.#persona.maxToolIterations; iteration += 1) {
      const response = await this.#gateway.complete({
        task: this.#persona.task,
        system: this.#persona.instructions,
        attribution: { tenantId: ctx.tenantId, sessionId: ctx.sessionId },
        // A snapshot, not the working array: the loop keeps appending to
        // `history`, and an adapter must see it as it was at call time.
        messages: [...history],
        ...(toolSchemas ? { tools: toolSchemas } : {}),
      });
      usage.add(response.usage);

      const assistantTurn: ModelMessage = { role: 'assistant', content: response.content };
      history.push(assistantTurn);
      await this.#sessions.append(ctx.tenantId, ctx.sessionId, [assistantTurn]);

      const calls = toolCalls(response);
      if (response.stopReason !== 'tool_call' || calls.length === 0) {
        return {
          text: responseText(response),
          toolInvocations: invocations,
          modelCalls: usage.calls,
          usage: usage.total(),
          stopReason: response.stopReason === 'tool_call' ? 'end_turn' : response.stopReason,
        };
      }

      const settlement = await this.#settle(ctx, calls, invocations);
      if (settlement.status === 'awaiting') {
        return {
          ...awaitingReply(settlement.pending),
          toolInvocations: invocations,
          modelCalls: usage.calls,
          usage: usage.total(),
        };
      }

      const resultTurn: ModelMessage = { role: 'user', content: settlement.results };
      history.push(resultTurn);
      await this.#sessions.append(ctx.tenantId, ctx.sessionId, [resultTurn]);
    }

    // Out of iterations with the model still asking for tools. Returning what
    // we have beats looping: a stuck agent is a bug to see, not to hide.
    return {
      text: '',
      toolInvocations: invocations,
      modelCalls: usage.calls,
      usage: usage.total(),
      stopReason: 'iteration_limit',
    };
  }

  /**
   * Turn a set of tool calls into results, or pause for approval.
   *
   * Nothing in the turn runs until the whole turn is settled: if any call is
   * gated and undecided, the agent records pending approvals (for the gated
   * calls only) and pauses before executing even the ungated ones. This keeps
   * a turn all-or-nothing, so a half-run turn can never be observed.
   */
  async #settle(
    ctx: Context,
    calls: readonly ToolCallPart[],
    invocations: ToolInvocation[],
  ): Promise<Settlement> {
    const gated = calls.filter((call) => this.#tools.requiresApproval(call.name));

    if (gated.length > 0 && this.#approvals) {
      const existing = await this.#approvals.forToolCalls(
        ctx.tenantId,
        ctx.sessionId,
        gated.map((call) => call.id),
      );
      const byToolCall = new Map(existing.map((approval) => [approval.toolCallId, approval]));

      // First time we see this turn: record the pending approvals and pause.
      const missing = gated.filter((call) => !byToolCall.has(call.id));
      if (missing.length > 0) {
        const created = await this.#approvals.request(
          missing.map((call) => ({
            tenantId: ctx.tenantId,
            sessionId: ctx.sessionId,
            toolCallId: call.id,
            toolName: call.name,
            input: call.input,
          })),
        );
        for (const approval of created) byToolCall.set(approval.toolCallId, approval);
      }

      const stillPending = [...byToolCall.values()].filter((a) => a.status === 'pending');
      if (stillPending.length > 0) {
        return { status: 'awaiting', pending: stillPending };
      }
    }

    // Every gate is decided (or there were none): run the turn.
    const results: ToolResultPart[] = [];
    const decisions =
      gated.length > 0 && this.#approvals
        ? new Map(
            (
              await this.#approvals.forToolCalls(
                ctx.tenantId,
                ctx.sessionId,
                gated.map((call) => call.id),
              )
            ).map((approval) => [approval.toolCallId, approval]),
          )
        : new Map<string, Approval>();

    for (const call of calls) {
      const result = await this.#runCall(ctx, call, decisions.get(call.id));
      invocations.push({
        name: call.name,
        input: call.input,
        output: result.content,
        isError: result.isError,
      });
      results.push({
        type: 'tool_result',
        toolCallId: call.id,
        content: result.content,
        isError: result.isError,
      });
    }

    return { status: 'ready', results };
  }

  async #runCall(
    ctx: Context,
    call: ToolCallPart,
    approval: Approval | undefined,
  ): Promise<{ content: string; isError: boolean }> {
    if (this.#tools.requiresApproval(call.name)) {
      if (!this.#approvals) {
        // Fail closed: no approval queue wired, so a gated tool does not run.
        return {
          content: `tool "${call.name}" requires human approval, which is not configured`,
          isError: true,
        };
      }
      if (approval?.status === 'rejected') {
        const because = approval.reason ? `: ${approval.reason}` : '';
        return {
          content: `tool "${call.name}" was rejected by ${approval.decidedBy ?? 'an operator'}${because}`,
          isError: true,
        };
      }
      if (approval?.status !== 'approved') {
        // Should not happen — #settle gates this — but never run an undecided
        // gated call.
        return { content: `tool "${call.name}" is not approved`, isError: true };
      }
    }

    return this.#tools.execute(call.name, call.input, ctx);
  }

  async #requireSession(ctx: Context): Promise<void> {
    const session = await this.#sessions.find(ctx.tenantId, ctx.sessionId);
    if (!session) {
      throw new SessionNotFoundError(ctx.tenantId, ctx.sessionId);
    }
  }
}

function awaitingReply(pending: Approval[]): AgentReply {
  return {
    text: '',
    toolInvocations: [],
    modelCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    stopReason: 'awaiting_approval',
    pendingApprovals: pending,
  };
}

class UsageTotal {
  #input = 0;
  #output = 0;
  #cached = 0;
  calls = 0;

  add(usage: TokenUsage): void {
    this.#input += usage.inputTokens;
    this.#output += usage.outputTokens;
    this.#cached += usage.cachedInputTokens;
    this.calls += 1;
  }

  total(): TokenUsage {
    return {
      inputTokens: this.#input,
      outputTokens: this.#output,
      cachedInputTokens: this.#cached,
    };
  }
}
