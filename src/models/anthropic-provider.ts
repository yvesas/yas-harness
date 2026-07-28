// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: Anthropic behind the ModelProvider port.
 *
 * Called directly, with no third-party router in between — an intermediary
 * would be one more party in the data path, which is exactly what the LGPD
 * posture rules out.
 *
 * It does one call. Which model to use, whether to retry and what it cost are
 * the routed gateway's business, not this file's.
 */

import Anthropic from '@anthropic-ai/sdk';

import type {
  ContentPart,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ResponsePart,
  StopReason,
  TaskKind,
  ToolSchema,
  TokenUsage,
} from './model-gateway.js';
import { cachePrefixLength, ModelGatewayError } from './model-gateway.js';
import type { ModelProvider, ProviderCall } from './model-provider.js';

const PROVIDER = 'anthropic';

/** Non-streaming ceiling: high enough to be useful, low enough to not time out. */
const DEFAULT_MAX_OUTPUT_TOKENS = 16_000;

/** The provider's cache marker. The default lifetime suits a live conversation. */
const CACHE_BREAKPOINT = { type: 'ephemeral' } as const;

/**
 * The only block kinds this adapter emits — the three the port's `ContentPart`
 * maps onto. Naming them (rather than using the provider's full block union)
 * is what lets a cache breakpoint be attached: the union includes blocks, such
 * as thinking, that do not accept one and that this adapter never produces.
 */
type EmittedBlock =
  Anthropic.TextBlockParam | Anthropic.ToolUseBlockParam | Anthropic.ToolResultBlockParam;

interface EmittedMessage {
  role: 'user' | 'assistant';
  content: EmittedBlock[];
}

export interface AnthropicProviderOptions {
  /** Defaults to the SDK's own resolution (ANTHROPIC_API_KEY, or a profile). */
  readonly apiKey?: string;
  readonly maxOutputTokens?: number;
  /** Injected in tests; production leaves it unset. */
  readonly client?: Anthropic;
}

export class AnthropicProvider implements ModelProvider {
  readonly name = PROVIDER;
  readonly #client: Anthropic;
  readonly #maxOutputTokens: number;

  constructor(options: AnthropicProviderOptions = {}) {
    this.#client =
      options.client ??
      new Anthropic(options.apiKey === undefined ? {} : { apiKey: options.apiKey });
    this.#maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
  }

  async invoke({ model, request, signal }: ProviderCall): Promise<ModelResponse> {
    const startedAt = performance.now();

    let message: Anthropic.Message;
    try {
      message = await this.#client.messages.create(
        toCreateParams(model, request, this.#maxOutputTokens),
        signal ? { signal } : {},
      );
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

/**
 * Translate a request, marking the caller's cacheable prefix if it declared one.
 *
 * The provider caches everything *before* a breakpoint and renders the prompt as
 * tools → system → messages, so one marker at the end of the declared prefix
 * covers exactly that region and nothing else. Deliberately no second marker at
 * the end of the request: the tail changes every turn, and marking it would pay
 * the write premium for an entry no later call can read.
 */
function toCreateParams(
  model: string,
  request: ModelRequest,
  defaultMaxOutputTokens: number,
): Anthropic.MessageCreateParamsNonStreaming {
  const messages = request.messages.map(toAnthropicMessage);
  const tools = request.tools?.length ? request.tools.map(toAnthropicTool) : undefined;
  let system: string | Anthropic.TextBlockParam[] | undefined = request.system;

  const prefixLength = cachePrefixLength(request);
  if (prefixLength !== undefined) {
    // Walk backwards through the prefix to the last block it actually contains:
    // its final message, else the system prompt, else the last tool.
    const lastPrefixMessage = prefixLength > 0 ? messages[prefixLength - 1] : undefined;
    if (lastPrefixMessage) {
      messages[prefixLength - 1] = markMessage(lastPrefixMessage);
    } else if (request.system !== undefined) {
      system = [{ type: 'text', text: request.system, cache_control: CACHE_BREAKPOINT }];
    } else if (tools && tools.length > 0) {
      tools[tools.length - 1] = { ...tools[tools.length - 1]!, cache_control: CACHE_BREAKPOINT };
    }
  }

  return {
    model,
    max_tokens: request.maxOutputTokens ?? defaultMaxOutputTokens,
    ...(system === undefined ? {} : { system }),
    messages,
    ...(tools === undefined ? {} : { tools }),
  };
}

/** Put the cache breakpoint on a message's last block — the end of the prefix. */
function markMessage(message: EmittedMessage): EmittedMessage {
  const last = message.content[message.content.length - 1];
  if (!last) {
    return message;
  }
  return {
    ...message,
    content: [...message.content.slice(0, -1), { ...last, cache_control: CACHE_BREAKPOINT }],
  };
}

function toAnthropicTool(tool: ToolSchema): Anthropic.Tool {
  return {
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as Anthropic.Tool.InputSchema,
  };
}

function toAnthropicMessage(message: ModelMessage): EmittedMessage {
  return {
    role: message.role,
    content: message.content.map(toAnthropicContent),
  };
}

function toAnthropicContent(part: ContentPart): EmittedBlock {
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
