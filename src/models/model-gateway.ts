// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Port: the only way the core talks to an AI model.
 *
 * The vocabulary here is deliberately provider-neutral — nothing in this file
 * names Anthropic, Groq or any wire format. Adapters translate. That is what
 * lets the harness add a provider, or let a customer bring their own model,
 * without the agent loop changing.
 */

/**
 * What kind of work a request is, which is what the gateway routes on.
 *
 * The caller states the nature of the task; the gateway decides which model
 * earns it. A caller never names a model — that would put provider knowledge
 * back in the core.
 */
export type TaskKind =
  /** Cheap triage: "is this about the calendar or about money?" */
  | 'routing'
  /** Classification, extraction, formatting. */
  | 'simple'
  /** Planning, summarising, ambiguity. */
  | 'reasoning'
  /** Never routed to a cheap model, whatever the cost. */
  | 'sensitive';

export interface TextPart {
  readonly type: 'text';
  readonly text: string;
}

/** The model asking for a tool to run. */
export interface ToolCallPart {
  readonly type: 'tool_call';
  readonly id: string;
  readonly name: string;
  readonly input: unknown;
}

/** The answer we hand back for a tool call. */
export interface ToolResultPart {
  readonly type: 'tool_result';
  readonly toolCallId: string;
  readonly content: string;
  readonly isError: boolean;
}

export type ContentPart = TextPart | ToolCallPart | ToolResultPart;

/** What a model may produce — it never authors a tool result. */
export type ResponsePart = TextPart | ToolCallPart;

export interface ModelMessage {
  readonly role: 'user' | 'assistant';
  readonly content: readonly ContentPart[];
}

/**
 * A tool as the model sees it: a name, a description and a JSON Schema.
 *
 * Deliberately not a Zod schema — the port must stay free of the validation
 * library the tool registry happens to use.
 */
export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: Record<string, unknown>;
}

/**
 * Who a call belongs to. Carried on the request so cost can be attributed to a
 * tenant and a conversation without the core knowing how usage is recorded.
 */
export interface RequestAttribution {
  readonly tenantId: string;
  readonly sessionId?: string;
}

/**
 * The leading part of a request a provider may cache and re-serve cheaply.
 *
 * Providers price this as a *prefix match*: a request whose leading bytes are
 * byte-identical to an earlier one is billed a fraction of the input rate for
 * that region. Only the caller knows how much of its context is stable from one
 * turn to the next, so it declares that here — the harness never guesses.
 *
 * The prefix is `system`, then `tools`, then the first `stableMessages`
 * messages. Declaring it has two effects: an adapter whose provider supports
 * caching asks for exactly that region to be cached, and the context compressor
 * leaves it untouched — a rewritten prefix no longer matches, and one miss
 * costs far more than compressing it would ever have saved.
 */
export interface CachePrefix {
  /**
   * How many leading messages are stable across turns. `0` declares only
   * `system` and `tools`, which is the usual case early in a conversation.
   */
  readonly stableMessages: number;
}

export interface ModelRequest {
  readonly task: TaskKind;
  readonly attribution?: RequestAttribution;
  readonly system?: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ToolSchema[];
  readonly maxOutputTokens?: number;
  readonly cachePrefix?: CachePrefix;
}

export type StopReason =
  /** The model finished its answer. */
  | 'end_turn'
  /** The model wants one or more tools to run before continuing. */
  | 'tool_call'
  /** The output ceiling was reached; the answer is truncated. */
  | 'max_tokens'
  /** The provider declined the request. */
  | 'refusal';

/**
 * Token counts for one call. Cost is derived from these in `telemetry/`, not
 * here — providers price differently and prices change.
 */
export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input tokens served from the provider's cache, billed at a lower rate. */
  readonly cachedInputTokens: number;
}

export interface ModelResponse {
  /** The model that actually answered, for traces and cost accounting. */
  readonly model: string;
  readonly content: readonly ResponsePart[];
  readonly stopReason: StopReason;
  readonly usage: TokenUsage;
  readonly latencyMs: number;
}

export interface ModelGateway {
  complete(request: ModelRequest): Promise<ModelResponse>;
}

/** Every provider failure reaches the core as this, never as a provider type. */
/**
 * Whose fault a retryable failure is — which decides *what* to back off from.
 *
 * `retryable` alone cannot answer that: a 500 and a 429 are both worth another
 * attempt, but a provider outage affects everyone and a quota belongs to one
 * caller's key. Backing off the wrong one either punishes tenants who are fine
 * or keeps hammering a provider that is down.
 */
export type FailureKind =
  /** The provider is unwell: 5xx, a timeout, a connection that never landed. */
  | 'provider'
  /** This caller's credential: a rate limit or a quota it has exhausted. */
  | 'credential'
  /** The request itself was refused, and will be refused again. */
  | 'request';

export class ModelGatewayError extends Error {
  constructor(
    message: string,
    readonly detail: {
      readonly provider: string;
      readonly task: TaskKind;
      /** True for rate limits, timeouts and provider outages. */
      readonly retryable: boolean;
      /** Defaults to `provider` when retryable, `request` when not. */
      readonly kind?: FailureKind;
      /** From the provider's `Retry-After`, when it said one. */
      readonly retryAfterMs?: number;
    },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ModelGatewayError';
  }

  /** The kind, resolved: adapters that do not classify still get a sane answer. */
  get kind(): FailureKind {
    return this.detail.kind ?? (this.detail.retryable ? 'provider' : 'request');
  }
}

/** Convenience for the common case of a single-text-part user turn. */
export function userMessage(text: string): ModelMessage {
  return { role: 'user', content: [{ type: 'text', text }] };
}

/** All text a response carries, joined — what a caller usually wants. */
export function responseText(response: ModelResponse): string {
  return response.content
    .filter((part): part is TextPart => part.type === 'text')
    .map((part) => part.text)
    .join('');
}

/** The tool calls a response is waiting on. */
export function toolCalls(response: ModelResponse): ToolCallPart[] {
  return response.content.filter((part): part is ToolCallPart => part.type === 'tool_call');
}

/**
 * How many leading messages a request's cacheable prefix covers, or `undefined`
 * when it declares none.
 *
 * A declaration of `0` and no declaration at all are different answers: `0`
 * still means "cache `system` and `tools`", so callers must tell them apart.
 * The count is clamped to the messages actually present — a caller that trims
 * its history without updating the hint gets a shorter prefix, not a crash.
 */
export function cachePrefixLength(request: ModelRequest): number | undefined {
  const declared = request.cachePrefix?.stableMessages;
  if (declared === undefined) {
    return undefined;
  }
  return Math.min(Math.max(Math.trunc(declared), 0), request.messages.length);
}
