// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: a gateway that replays a script instead of calling a provider.
 *
 * Shipped with the harness rather than hidden in the test folder, because
 * every product built on the harness needs to test its own agents without a
 * network or an API bill.
 */

import type {
  ModelGateway,
  ModelRequest,
  ModelResponse,
  ResponsePart,
  StopReason,
  TokenUsage,
} from './model-gateway.js';

export interface ScriptedTurn {
  readonly content: readonly ResponsePart[];
  readonly stopReason?: StopReason;
  readonly usage?: Partial<TokenUsage>;
}

const NO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

/** A plain text answer that ends the turn. */
export function says(text: string): ScriptedTurn {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

/** A turn that asks for one tool and waits for its result. */
export function callsTool(name: string, input: unknown, id = `call-${name}`): ScriptedTurn {
  return {
    content: [{ type: 'tool_call', id, name, input }],
    stopReason: 'tool_call',
  };
}

export class ScriptedGateway implements ModelGateway {
  readonly #turns: ScriptedTurn[];
  /** Every request received, so tests can assert on what the core sent. */
  readonly requests: ModelRequest[] = [];

  constructor(turns: readonly ScriptedTurn[]) {
    this.#turns = [...turns];
  }

  complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(request);

    const turn = this.#turns.shift();
    if (!turn) {
      // Silently answering would turn a wrong number of model calls into a
      // passing test.
      return Promise.reject(
        new Error(`ScriptedGateway ran out of turns after ${this.requests.length} request(s)`),
      );
    }

    return Promise.resolve({
      model: `scripted/${request.task}`,
      content: turn.content,
      stopReason: turn.stopReason ?? 'end_turn',
      usage: { ...NO_USAGE, ...turn.usage },
      latencyMs: 0,
    });
  }

  get remaining(): number {
    return this.#turns.length;
  }
}
