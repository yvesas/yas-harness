// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: Groq behind the ModelProvider port.
 *
 * Groq exposes an OpenAI-compatible chat API, which is a different shape from
 * the port's: tool results are their own messages rather than parts of a user
 * turn, and tool arguments travel as a JSON string. That translation is the
 * whole job of this file, and the reason the core never sees either detail.
 *
 * Written against `fetch` rather than a client library: the surface used here
 * is three fields wide, and a dependency would buy nothing but a version to
 * keep up with.
 */

import type {
  ContentPart,
  ModelMessage,
  ModelResponse,
  ResponsePart,
  StopReason,
  TaskKind,
  TokenUsage,
} from './model-gateway.js';
import { ModelGatewayError } from './model-gateway.js';
import type { ModelProvider, ProviderCall } from './model-provider.js';

const PROVIDER = 'groq';
const DEFAULT_BASE_URL = 'https://api.groq.com/openai/v1';
const DEFAULT_MAX_OUTPUT_TOKENS = 8_000;

/** Status codes worth another attempt: rate limits and provider-side faults. */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export interface GroqProviderOptions {
  /** Defaults to GROQ_API_KEY. */
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly maxOutputTokens?: number;
  /** Injected in tests. */
  readonly fetch?: typeof globalThis.fetch;
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: { id: string; type: 'function'; function: { name: string; arguments: string } }[];
  tool_call_id?: string;
}

interface ChatCompletion {
  model: string;
  choices: {
    finish_reason: string;
    message: {
      content: string | null;
      tool_calls?: { id: string; function: { name: string; arguments: string } }[];
    };
  }[];
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    prompt_tokens_details?: { cached_tokens?: number };
  };
}

export class GroqProvider implements ModelProvider {
  readonly name = PROVIDER;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #maxOutputTokens: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: GroqProviderOptions = {}) {
    const apiKey = options.apiKey ?? process.env['GROQ_API_KEY'];
    if (!apiKey) {
      throw new ModelGatewayError('GROQ_API_KEY is not set', {
        provider: PROVIDER,
        task: 'simple',
        retryable: false,
      });
    }

    this.#apiKey = apiKey;
    this.#baseUrl = options.baseUrl ?? DEFAULT_BASE_URL;
    this.#maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async invoke({ model, request, signal }: ProviderCall): Promise<ModelResponse> {
    const startedAt = performance.now();

    const body = {
      model,
      max_tokens: request.maxOutputTokens ?? this.#maxOutputTokens,
      messages: toChatMessages(request.system, request.messages),
      ...(request.tools && request.tools.length > 0
        ? {
            tools: request.tools.map((tool) => ({
              type: 'function' as const,
              function: {
                name: tool.name,
                description: tool.description,
                parameters: tool.inputSchema,
              },
            })),
          }
        : {}),
    };

    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      // A transport failure never reached the provider, so it is worth another
      // attempt — including the gateway's own timeout aborting the request.
      throw new ModelGatewayError(`groq request failed: ${errorMessage(error)}`, {
        provider: PROVIDER,
        task: request.task,
        retryable: true,
      });
    }

    if (!response.ok) {
      throw await toHttpError(response, request.task);
    }

    const completion = (await response.json()) as ChatCompletion;
    const choice = completion.choices[0];
    if (!choice) {
      throw new ModelGatewayError('groq returned no choices', {
        provider: PROVIDER,
        task: request.task,
        retryable: true,
      });
    }

    return {
      model: completion.model,
      content: toResponseParts(choice.message),
      stopReason: toStopReason(choice.finish_reason),
      usage: toUsage(completion.usage),
      latencyMs: Math.round(performance.now() - startedAt),
    };
  }
}

/**
 * The port keeps tool results inside the user turn that answers a tool call;
 * the OpenAI shape wants one `tool` message per result. Splitting here keeps
 * that asymmetry out of the core.
 */
function toChatMessages(
  system: string | undefined,
  messages: readonly ModelMessage[],
): ChatMessage[] {
  const chat: ChatMessage[] = system === undefined ? [] : [{ role: 'system', content: system }];

  for (const message of messages) {
    const text = joinText(message.content);
    const calls = message.content.filter((part) => part.type === 'tool_call');
    const results = message.content.filter((part) => part.type === 'tool_result');

    for (const result of results) {
      chat.push({
        role: 'tool',
        tool_call_id: result.toolCallId,
        content: result.content,
      });
    }

    if (calls.length > 0) {
      chat.push({
        role: 'assistant',
        content: text === '' ? null : text,
        tool_calls: calls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.input) },
        })),
      });
      continue;
    }

    // A turn that carried only tool results has already been emitted above.
    if (text !== '' || results.length === 0) {
      chat.push({ role: message.role, content: text });
    }
  }

  return chat;
}

function joinText(content: readonly ContentPart[]): string {
  return content
    .filter((part) => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

function toResponseParts(message: ChatCompletion['choices'][number]['message']): ResponsePart[] {
  const parts: ResponsePart[] = [];

  if (message.content) {
    parts.push({ type: 'text', text: message.content });
  }

  for (const call of message.tool_calls ?? []) {
    parts.push({
      type: 'tool_call',
      id: call.id,
      name: call.function.name,
      // Arguments arrive as a JSON string. Malformed JSON is the model's
      // mistake, not a crash: it reaches the tool as input the schema then
      // rejects, and the model gets a chance to correct it.
      input: parseArguments(call.function.arguments),
    });
  }

  return parts;
}

function parseArguments(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return { __unparsed_arguments: raw };
  }
}

function toStopReason(reason: string): StopReason {
  switch (reason) {
    case 'tool_calls':
      return 'tool_call';
    case 'length':
      return 'max_tokens';
    case 'content_filter':
      return 'refusal';
    default:
      return 'end_turn';
  }
}

function toUsage(usage: ChatCompletion['usage']): TokenUsage {
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  return {
    // prompt_tokens includes cached tokens; the port reports them apart so
    // they can be priced apart.
    inputTokens: Math.max((usage?.prompt_tokens ?? 0) - cached, 0),
    outputTokens: usage?.completion_tokens ?? 0,
    cachedInputTokens: cached,
  };
}

async function toHttpError(response: Response, task: TaskKind): Promise<ModelGatewayError> {
  const body = await response.text().catch(() => '');
  return new ModelGatewayError(`groq responded ${response.status}: ${body.slice(0, 500)}`, {
    provider: PROVIDER,
    task,
    retryable: RETRYABLE_STATUS.has(response.status),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
