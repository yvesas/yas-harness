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

export interface ModelRequest {
  readonly task: TaskKind;
  readonly attribution?: RequestAttribution;
  readonly system?: string;
  readonly messages: readonly ModelMessage[];
  readonly tools?: readonly ToolSchema[];
  readonly maxOutputTokens?: number;
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
export class ModelGatewayError extends Error {
  constructor(
    message: string,
    readonly detail: {
      readonly provider: string;
      readonly task: TaskKind;
      /** True for rate limits, timeouts and provider outages. */
      readonly retryable: boolean;
    },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ModelGatewayError';
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
