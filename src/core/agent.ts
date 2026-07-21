// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The agent loop: input -> model -> tools -> answer.
 *
 * It depends on three ports and nothing else — a model gateway, a session
 * store and a tool registry. No provider, no database, no product domain. That
 * is what makes this file testable without a network and reusable by every
 * product built on the harness.
 */

import type {
  ModelGateway,
  ModelMessage,
  ModelResponse,
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
}

export interface AgentTurn {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly input: string;
}

/** One tool call and what it produced, kept for the trace. */
export interface ToolInvocation {
  readonly name: string;
  readonly input: unknown;
  readonly output: string;
  readonly isError: boolean;
}

export interface AgentReply {
  readonly text: string;
  readonly toolInvocations: readonly ToolInvocation[];
  /** Model calls this turn took — one per loop iteration. */
  readonly modelCalls: number;
  readonly usage: TokenUsage;
  readonly stopReason: 'end_turn' | 'max_tokens' | 'refusal' | 'iteration_limit';
}

export class AgentError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'AgentError';
  }
}

export class Agent {
  readonly #gateway: ModelGateway;
  readonly #sessions: SessionStore;
  readonly #tools: ToolRegistry;
  readonly #persona: Persona;

  constructor(dependencies: AgentDependencies) {
    this.#gateway = dependencies.gateway;
    this.#sessions = dependencies.sessions;
    this.#tools = dependencies.tools;
    this.#persona = dependencies.persona;
  }

  /**
   * Run one user turn to completion.
   *
   * Everything produced along the way — the user message, each assistant turn
   * and each tool result — is appended to the session, so a restart mid-turn
   * loses the in-flight call but not the conversation.
   */
  async run(turn: AgentTurn): Promise<AgentReply> {
    const { tenantId, sessionId } = turn;

    const session = await this.#sessions.find(tenantId, sessionId);
    if (!session) {
      throw new SessionNotFoundError(tenantId, sessionId);
    }

    const userTurn: ModelMessage = {
      role: 'user',
      content: [{ type: 'text', text: turn.input }],
    };
    await this.#sessions.append(tenantId, sessionId, [userTurn]);

    const history: ModelMessage[] = await this.#sessions.messages(tenantId, sessionId);
    const invocations: ToolInvocation[] = [];
    const usage = new UsageTotal();
    const toolSchemas = this.#tools.size > 0 ? this.#tools.schemas() : undefined;

    for (let iteration = 0; iteration < this.#persona.maxToolIterations; iteration += 1) {
      const response: ModelResponse = await this.#gateway.complete({
        task: this.#persona.task,
        system: this.#persona.instructions,
        // Carried so the gateway can attribute cost to this conversation.
        attribution: { tenantId, sessionId },
        // A snapshot, not the working array: the loop keeps appending to
        // `history`, and an adapter must see the conversation as it was at
        // call time.
        messages: [...history],
        ...(toolSchemas ? { tools: toolSchemas } : {}),
      });
      usage.add(response.usage);

      const assistantTurn: ModelMessage = { role: 'assistant', content: response.content };
      history.push(assistantTurn);
      await this.#sessions.append(tenantId, sessionId, [assistantTurn]);

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

      // The model may ask for several tools at once; all results go back in a
      // single user turn, which is what keeps parallel calls working.
      const results: ToolResultPart[] = [];
      for (const call of calls) {
        const result = await this.#runTool(call.name, call.input, {
          tenantId,
          sessionId,
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

      const resultTurn: ModelMessage = { role: 'user', content: results };
      history.push(resultTurn);
      await this.#sessions.append(tenantId, sessionId, [resultTurn]);
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

  async #runTool(
    name: string,
    input: unknown,
    context: { tenantId: string; sessionId: string },
  ): Promise<{ content: string; isError: boolean }> {
    // Fail closed: approval-gated tools do not run until the approval queue
    // exists. Executing them unchecked would be the wrong default to ship.
    if (this.#tools.requiresApproval(name)) {
      return {
        content: `tool "${name}" requires human approval, which is not available yet`,
        isError: true,
      };
    }
    return this.#tools.execute(name, input, context);
  }
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
