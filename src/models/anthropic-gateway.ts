// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: Anthropic behind the ModelGateway port.
 *
 * Called directly, with no third-party router in between — an intermediary
 * would be one more party in the data path, which is exactly what the LGPD
 * posture rules out.
 */

import Anthropic from '@anthropic-ai/sdk';

import type {
  ContentPart,
  ModelGateway,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ResponsePart,
  StopReason,
  TaskKind,
  TokenUsage,
} from './model-gateway.js';
import { ModelGatewayError } from './model-gateway.js';

const PROVIDER = 'anthropic';

/**
 * Which model serves which kind of work.
 *
 * `sensitive` deliberately shares the capable model with `reasoning`: getting
 * a balance wrong costs more than the tokens saved. Selection strategy, model
 * fallback and cost accounting belong to the gateway layer above this adapter.
 */
export const DEFAULT_MODELS: Readonly<Record<TaskKind, string>> = {
  routing: 'claude-haiku-4-5',
  simple: 'claude-haiku-4-5',
  reasoning: 'claude-opus-4-8',
  sensitive: 'claude-opus-4-8',
};

/** Non-streaming ceiling: high enough to be useful, low enough to not time out. */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

export interface AnthropicGatewayOptions {
  /** Defaults to the SDK's own resolution (ANTHROPIC_API_KEY, or a profile). */
  readonly apiKey?: string;
  readonly models?: Partial<Record<TaskKind, string>>;
  readonly maxOutputTokens?: number;
  /** Injected in tests; production leaves it unset. */
  readonly client?: Anthropic;
}

export class AnthropicGateway implements ModelGateway {
  readonly #client: Anthropic;
  readonly #models: Record<TaskKind, string>;
  readonly #maxOutputTokens: number;

  constructor(options: AnthropicGatewayOptions = {}) {
    this.#client =
      options.client ??
      new Anthropic(options.apiKey === undefined ? {} : { apiKey: options.apiKey });
    this.#models = { ...DEFAULT_MODELS, ...options.models };
    this.#maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const model = this.#models[request.task];
    const startedAt = performance.now();

    let message: Anthropic.Message;
    try {
      message = await this.#client.messages.create({
        model,
        max_tokens: request.maxOutputTokens ?? this.#maxOutputTokens,
        ...(request.system === undefined ? {} : { system: request.system }),
        messages: request.messages.map(toAnthropicMessage),
        ...(request.tools && request.tools.length > 0
          ? {
              tools: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
              })),
            }
          : {}),
      });
    } catch (error) {
      throw toGatewayError(error, request.task);
    }

    return {
      model: message.model,
      content: message.content.flatMap(toResponsePart),
      stopReason: toStopReason(message.stop_reason),
      usage: toUsage(message.usage),
      latencyMs: Math.round(performance.now() - startedAt),
    };
  }
}

function toAnthropicMessage(message: ModelMessage): Anthropic.MessageParam {
  return {
    role: message.role,
    content: message.content.map(toAnthropicContent),
  };
}

function toAnthropicContent(part: ContentPart): Anthropic.ContentBlockParam {
  switch (part.type) {
    case 'text':
      return { type: 'text', text: part.text };
    case 'tool_call':
      return {
        type: 'tool_use',
        id: part.id,
        name: part.name,
        input: part.input,
      };
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: part.toolCallId,
        content: part.content,
        is_error: part.isError,
      };
  }
}

/**
 * Blocks we have no port vocabulary for are dropped rather than guessed at.
 * Thinking blocks are the notable case: enabling extended thinking means
 * echoing them back unchanged, so the gateway does not enable it yet.
 */
function toResponsePart(block: Anthropic.ContentBlock): ResponsePart[] {
  switch (block.type) {
    case 'text':
      return [{ type: 'text', text: block.text }];
    case 'tool_use':
      return [{ type: 'tool_call', id: block.id, name: block.name, input: block.input }];
    default:
      return [];
  }
}

function toStopReason(reason: Anthropic.Message['stop_reason']): StopReason {
  switch (reason) {
    case 'tool_use':
      return 'tool_call';
    case 'max_tokens':
      return 'max_tokens';
    case 'refusal':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

function toUsage(usage: Anthropic.Usage): TokenUsage {
  return {
    inputTokens: usage.input_tokens,
    outputTokens: usage.output_tokens,
    cachedInputTokens: usage.cache_read_input_tokens ?? 0,
  };
}

/**
 * Rate limits, timeouts and provider outages are worth retrying; a rejected
 * request is not. The distinction is what the fallback strategy will act on.
 */
function toGatewayError(error: unknown, task: TaskKind): ModelGatewayError {
  const retryable =
    error instanceof Anthropic.RateLimitError ||
    error instanceof Anthropic.InternalServerError ||
    error instanceof Anthropic.APIConnectionError;

  const message = error instanceof Error ? error.message : String(error);

  return new ModelGatewayError(`anthropic request failed: ${message}`, {
    provider: PROVIDER,
    task,
    retryable,
  });
}
