// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: any OpenAI-compatible chat API behind the `ModelProvider` port.
 *
 * One adapter rather than one per vendor, because the vendors converged. The
 * `/chat/completions` shape is what Groq, Together, Fireworks, DeepInfra,
 * Cerebras, SambaNova, Mistral, xAI, OpenRouter, Nebius and OpenAI itself all
 * speak — and what a local vLLM, Ollama or LM Studio serves. Google's Gemini
 * exposes a compatible endpoint too. A vendor is therefore **configuration**:
 * a base URL, a key, a name. Adding one is an entry in `config/models.json`,
 * not a file in this folder.
 *
 * The shape differs from the port's: tool results are their own messages rather
 * than parts of a user turn, and tool arguments travel as a JSON string. That
 * translation is the whole job of this file, and the reason the core never sees
 * either detail.
 *
 * Written against `fetch` rather than a client library: the surface used here
 * is three fields wide, and a dependency would buy nothing but a version to
 * keep up with.
 *
 * What it does **not** cover is a provider's own extensions — prompt caching
 * with explicit cache breakpoints, for instance. A vendor whose distinguishing
 * feature the harness wants gets a native adapter beside this one; a vendor
 * that is a fast, cheap endpoint does not need one.
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

const DEFAULT_MAX_OUTPUT_TOKENS = 8_000;

/** Status codes worth another attempt: rate limits and provider-side faults. */
const RETRYABLE_STATUS = new Set([408, 409, 429, 500, 502, 503, 504]);

export interface OpenAiCompatibleOptions {
  /**
   * How this provider is named in `config/models.json`, and in every trace and
   * cost row. The harness has no opinion about it — `groq`, `together`,
   * `local`, whatever the deployment calls the thing it is talking to.
   */
  readonly name: string;
  /** Where `/chat/completions` lives, e.g. `https://api.groq.com/openai/v1`. */
  readonly baseUrl: string;
  /**
   * Which environment variable holds the key.
   *
   * Named by configuration rather than fixed in code: a vendor's convention is
   * the vendor's, and a harness that hardcodes one has picked a vendor. Two
   * deployments of the same provider can even use different variables.
   */
  readonly apiKeyEnv?: string;
  /** The key itself, when a caller would rather pass it than name a variable. */
  readonly apiKey?: string;
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

export class OpenAiCompatibleProvider implements ModelProvider {
  readonly name: string;
  readonly #apiKey: string;
  readonly #baseUrl: string;
  readonly #maxOutputTokens: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: OpenAiCompatibleOptions) {
    this.name = options.name;
    const apiKey =
      options.apiKey ?? (options.apiKeyEnv ? process.env[options.apiKeyEnv] : undefined);
    if (!apiKey) {
      // Names the variable the deployment chose, not one this file assumed.
      throw new ModelGatewayError(
        `${options.apiKeyEnv ?? `the API key for "${options.name}"`} is not set`,
        { provider: options.name, task: 'simple', retryable: false },
      );
    }

    this.#apiKey = apiKey;
    this.#baseUrl = options.baseUrl;
    this.#maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async invoke({ model, request, signal, apiKey }: ProviderCall): Promise<ModelResponse> {
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
          // The tenant's own key when they brought one (E3), ours otherwise.
          authorization: `Bearer ${apiKey ?? this.#apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(body),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      // A transport failure never reached the provider, so it is worth another
      // attempt — including the gateway's own timeout aborting the request.
      throw new ModelGatewayError(`${this.name} request failed: ${errorMessage(error)}`, {
        provider: this.name,
        task: request.task,
        retryable: true,
      });
    }

    if (!response.ok) {
      throw await toHttpError(this.name, response, request.task);
    }

    const completion = (await response.json()) as ChatCompletion;
    const choice = completion.choices[0];
    if (!choice) {
      throw new ModelGatewayError(`${this.name} returned no choices`, {
        provider: this.name,
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

async function toHttpError(
  provider: string,
  response: Response,
  task: TaskKind,
): Promise<ModelGatewayError> {
  const body = await response.text().catch(() => '');
  const retryable = RETRYABLE_STATUS.has(response.status);
  // 429 is this key's quota; 5xx is the provider. Backing off the wrong one
  // either punishes tenants who are fine or hammers a provider that is down.
  const credential = response.status === 429;
  const seconds = Number(response.headers.get('retry-after'));
  const retryAfterMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : undefined;

  return new ModelGatewayError(`${provider} responded ${response.status}: ${body.slice(0, 500)}`, {
    provider,
    task,
    retryable,
    kind: credential ? 'credential' : retryable ? 'provider' : 'request',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
