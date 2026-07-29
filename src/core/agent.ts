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
import type { TraceRecorder } from '../telemetry/trace.js';
import { TurnTrace } from '../telemetry/trace.js';

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
  /**
   * Where the steps of a turn are written. Without it the agent runs exactly as
   * before and records nothing — tracing is off until a product wires it.
   */
  readonly traces?: TraceRecorder;
}

export interface AgentTurn {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly input: string;
  /**
   * Joins this turn to a trace the caller already started — a routing decision,
   * typically. Omit and the agent begins one.
   */
  readonly traceId?: string;
}

export interface ResumeInput {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly traceId?: string;
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
  /** This turn's trace, so a caller can look up what happened. */
  readonly traceId: string;
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
  readonly trace: TurnTrace;
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
  readonly #traces: TraceRecorder | undefined;

  constructor(dependencies: AgentDependencies) {
    this.#gateway = dependencies.gateway;
    this.#sessions = dependencies.sessions;
    this.#tools = dependencies.tools;
    this.#persona = dependencies.persona;
    this.#approvals = dependencies.approvals;
    this.#traces = dependencies.traces;
  }

  #context(input: { tenantId: string; sessionId: string; traceId?: string }): Context {
    return {
      tenantId: input.tenantId,
      sessionId: input.sessionId,
      trace: new TurnTrace(this.#traces, {
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        ...(input.traceId === undefined ? {} : { traceId: input.traceId }),
      }),
    };
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
    const ctx = this.#context(turn);
    await this.#requireSession(ctx);

    // The message itself is not copied into the step: it is already stored, in
    // full, on this session. Repeating it would double the exposure of the
    // user's own words for no information a reader of the trace lacks.
    await ctx.trace.step({
      kind: 'input',
      succeeded: true,
      detail: { characters: turn.input.length },
    });

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
    const ctx = this.#context(input);
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
      return this.#finish(ctx, awaitingReply(settlement.pending, ctx.trace.traceId));
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
      let response;
      try {
        response = await this.#gateway.complete({
          task: this.#persona.task,
          system: this.#persona.instructions,
          attribution: { tenantId: ctx.tenantId, sessionId: ctx.sessionId },
          // A snapshot, not the working array: the loop keeps appending to
          // `history`, and an adapter must see it as it was at call time.
          messages: [...history],
          ...(toolSchemas ? { tools: toolSchemas } : {}),
        });
      } catch (error) {
        // A turn that died on the model call is exactly what a trace is for:
        // record the failed step, then let the error go where it was going.
        await ctx.trace.step({
          kind: 'model_call',
          succeeded: false,
          detail: { iteration },
          errorMessage: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }

      usage.add(response.usage);
      await ctx.trace.step({
        kind: 'model_call',
        label: response.model,
        durationMs: response.latencyMs,
        succeeded: true,
        detail: {
          iteration,
          stopReason: response.stopReason,
          inputTokens: response.usage.inputTokens,
          outputTokens: response.usage.outputTokens,
          cachedInputTokens: response.usage.cachedInputTokens,
        },
      });

      const assistantTurn: ModelMessage = { role: 'assistant', content: response.content };
      history.push(assistantTurn);
      await this.#sessions.append(ctx.tenantId, ctx.sessionId, [assistantTurn]);

      const calls = toolCalls(response);
      if (response.stopReason !== 'tool_call' || calls.length === 0) {
        return this.#finish(ctx, {
          text: responseText(response),
          toolInvocations: invocations,
          modelCalls: usage.calls,
          usage: usage.total(),
          stopReason: response.stopReason === 'tool_call' ? 'end_turn' : response.stopReason,
          traceId: ctx.trace.traceId,
        });
      }

      const settlement = await this.#settle(ctx, calls, invocations);
      if (settlement.status === 'awaiting') {
        return this.#finish(ctx, {
          ...awaitingReply(settlement.pending, ctx.trace.traceId),
          toolInvocations: invocations,
          modelCalls: usage.calls,
          usage: usage.total(),
        });
      }

      const resultTurn: ModelMessage = { role: 'user', content: settlement.results };
      history.push(resultTurn);
      await this.#sessions.append(ctx.tenantId, ctx.sessionId, [resultTurn]);
    }

    // Out of iterations with the model still asking for tools. Returning what
    // we have beats looping: a stuck agent is a bug to see, not to hide.
    return this.#finish(ctx, {
      text: '',
      toolInvocations: invocations,
      modelCalls: usage.calls,
      usage: usage.total(),
      stopReason: 'iteration_limit',
      traceId: ctx.trace.traceId,
    });
  }

  /**
   * Close the trace and hand back the reply.
   *
   * Every way a turn can end goes through here, so a trace always has a last
   * step saying how — including the ones that are not an answer: a pause for
   * approval and an exhausted iteration budget are the two outcomes someone
   * reading a trace is most likely to be looking for.
   */
  async #finish(ctx: Context, reply: AgentReply): Promise<AgentReply> {
    await ctx.trace.step({
      kind: 'reply',
      label: reply.stopReason,
      succeeded: reply.stopReason !== 'iteration_limit' && reply.stopReason !== 'refusal',
      detail: {
        modelCalls: reply.modelCalls,
        toolCalls: reply.toolInvocations.length,
        characters: reply.text.length,
      },
    });
    return reply;
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
        await ctx.trace.step({
          kind: 'approval',
          succeeded: true,
          detail: { waitingOn: stillPending.map((approval) => approval.toolName) },
        });
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
      const startedAt = performance.now();
      const result = await this.#runCall(ctx, call, decisions.get(call.id));
      await ctx.trace.step({
        kind: 'tool_call',
        label: call.name,
        durationMs: Math.round(performance.now() - startedAt),
        succeeded: !result.isError,
        // The input is what makes a tool step readable — the same call with
        // different arguments is a different event. It is redacted on the way
        // to storage, like every other free-form field.
        detail: { input: call.input },
        ...(result.isError ? { errorMessage: result.content } : {}),
      });
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

    // Only the identity of the turn crosses into a tool, never its tracer.
    return this.#tools.execute(call.name, call.input, {
      tenantId: ctx.tenantId,
      sessionId: ctx.sessionId,
    });
  }

  async #requireSession(ctx: Context): Promise<void> {
    const session = await this.#sessions.find(ctx.tenantId, ctx.sessionId);
    if (!session) {
      throw new SessionNotFoundError(ctx.tenantId, ctx.sessionId);
    }
  }
}

function awaitingReply(pending: Approval[], traceId: string): AgentReply {
  return {
    text: '',
    toolInvocations: [],
    modelCalls: 0,
    usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
    stopReason: 'awaiting_approval',
    pendingApprovals: pending,
    traceId,
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
