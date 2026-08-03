// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Trace steps, as OpenTelemetry spans.
 *
 * A trace is already span-shaped by design — an id, an ordinal, a kind, a
 * duration, an outcome — so this file is a translation and nothing more. It
 * holds no state and performs no I/O, which is what lets a product send spans
 * somewhere this repository has never heard of: call `toSpan` and do what you
 * like with the result. `OtlpTraceRecorder` is one such caller.
 *
 * The wire shape is **OTLP/JSON**, the format every collector accepts over
 * HTTP, written by hand against the protocol definition. Bringing in the
 * OpenTelemetry SDK would mean a dependency tree, a global provider and a
 * shutdown lifecycle for a payload that is this small — and the harness is a
 * library, so that tree lands in every product whether or not it exports
 * anything. What is gained by depending on it is auto-instrumentation of
 * things the harness does not do.
 *
 * Two shapes here are conventions rather than choices:
 *
 * - **Ids are derived, never random.** A span id is a hash of
 *   `traceId:sequence`, so the same step exported twice is the same span rather
 *   than a duplicate, and a child can name its parent without anyone holding
 *   state between calls.
 * - **Step 0 is the parent of the rest.** OTLP wants a tree and a trace is a
 *   flat list, but the first step of a turn *is* the turn beginning — so it
 *   becomes the root and every later step hangs off it. Since its id derives
 *   from the trace id alone, no bookkeeping is required to point at it.
 */

import { createHash } from 'node:crypto';

import type { TraceStep, TraceStepKind } from './trace.js';

/** OTLP `SpanKind`. The harness only ever produces these two. */
const SPAN_KIND_INTERNAL = 1;
const SPAN_KIND_CLIENT = 3;

/** OTLP `StatusCode`. `UNSET` is the convention for "fine", not `OK`. */
const STATUS_UNSET = 0;
const STATUS_ERROR = 2;

/** An OTLP attribute value, in the JSON mapping of the protocol. */
export type OtlpValue =
  | { readonly stringValue: string }
  | { readonly intValue: string }
  | { readonly doubleValue: number }
  | { readonly boolValue: boolean };

export interface OtlpAttribute {
  readonly key: string;
  readonly value: OtlpValue;
}

export interface OtlpSpan {
  readonly traceId: string;
  readonly spanId: string;
  readonly parentSpanId?: string;
  readonly name: string;
  readonly kind: number;
  readonly startTimeUnixNano: string;
  readonly endTimeUnixNano: string;
  readonly attributes: readonly OtlpAttribute[];
  readonly status: { readonly code: number; readonly message?: string };
}

/** What a collector receives: one POST body. */
export interface OtlpTracePayload {
  readonly resourceSpans: readonly {
    readonly resource: { readonly attributes: readonly OtlpAttribute[] };
    readonly scopeSpans: readonly {
      readonly scope: { readonly name: string; readonly version?: string };
      readonly spans: readonly OtlpSpan[];
    }[];
  }[];
}

export interface SpanOptions {
  /**
   * When the step ended. Defaults to now, which is what it is: `record` is
   * called the moment the step finishes.
   */
  readonly endedAt?: Date;
}

/**
 * Where a turn's steps sit in the semantic conventions.
 *
 * Only two kinds have an agreed name in the GenAI conventions; the rest are
 * harness concepts with no equivalent, and inventing a `gen_ai.*` name for them
 * would be worse than leaving them under our own prefix, where a reader knows
 * to go looking for what they mean.
 */
const OPERATION_NAMES: Partial<Record<TraceStepKind, string>> = {
  model_call: 'chat',
  tool_call: 'execute_tool',
};

/** A model call leaves the process; everything else happens inside it. */
function spanKind(kind: TraceStepKind): number {
  return kind === 'model_call' ? SPAN_KIND_CLIENT : SPAN_KIND_INTERNAL;
}

function attribute(key: string, value: unknown): OtlpAttribute | null {
  if (typeof value === 'string') {
    return { key, value: { stringValue: value } };
  }
  if (typeof value === 'boolean') {
    return { key, value: { boolValue: value } };
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    // int64 travels as a string in the JSON mapping: past 2^53 a JSON number
    // is no longer the integer that was sent.
    return Number.isInteger(value)
      ? { key, value: { intValue: String(value) } }
      : { key, value: { doubleValue: value } };
  }
  if (value === null || value === undefined) {
    // An absent attribute and one set to null read the same in a backend, and
    // the second one costs bytes.
    return null;
  }
  return { key, value: { stringValue: JSON.stringify(value) } };
}

/**
 * The GenAI conventions for the two kinds that have them, so a backend's model
 * dashboards work on our spans without anyone configuring a mapping.
 */
function semanticAttributes(step: TraceStep): Record<string, unknown> {
  const operation = OPERATION_NAMES[step.kind];
  if (operation === undefined) {
    return {};
  }

  const attributes: Record<string, unknown> = { 'gen_ai.operation.name': operation };
  if (step.kind === 'tool_call') {
    attributes['gen_ai.tool.name'] = step.label;
    return attributes;
  }

  // `response.model`, not `request.model`: the label is what actually answered,
  // which after a fallback is not what was asked for.
  attributes['gen_ai.response.model'] = step.label;
  const detail = step.detail ?? {};
  if (typeof detail['stopReason'] === 'string') {
    attributes['gen_ai.response.finish_reasons'] = detail['stopReason'];
  }
  attributes['gen_ai.usage.input_tokens'] = detail['inputTokens'];
  attributes['gen_ai.usage.output_tokens'] = detail['outputTokens'];
  attributes['gen_ai.usage.cache_read_input_tokens'] = detail['cachedInputTokens'];
  return attributes;
}

function nanos(at: Date): string {
  // Milliseconds are the finest thing the source has; the zeros are honest
  // padding rather than precision anyone should read into.
  return `${String(at.getTime())}000000`;
}

const HEX = /^[0-9a-f]+$/;

/** 16 bytes of hex, as OTLP requires — a UUID already is that, once unhyphenated. */
export function toTraceId(traceId: string): string {
  const compact = traceId.replaceAll('-', '').toLowerCase();
  if (compact.length === 32 && HEX.test(compact)) {
    return compact;
  }
  // Callers may share a trace id across components, so it is not guaranteed to
  // be a UUID. Hashing keeps it stable and the right width either way.
  return createHash('sha256').update(traceId).digest('hex').slice(0, 32);
}

/** 8 bytes of hex, derived so that the same step is always the same span. */
export function toSpanId(traceId: string, sequence: number): string {
  return createHash('sha256')
    .update(`${traceId}:${String(sequence)}`)
    .digest('hex')
    .slice(0, 16);
}

/** One step, as one span. */
export function toSpan(step: TraceStep, options: SpanOptions = {}): OtlpSpan {
  const endedAt = options.endedAt ?? new Date();
  const startedAt = new Date(endedAt.getTime() - (step.durationMs ?? 0));

  const attributes: OtlpAttribute[] = [];
  const push = (key: string, value: unknown): void => {
    const built = attribute(key, value);
    if (built) attributes.push(built);
  };

  push('yas.step.kind', step.kind);
  push('yas.step.sequence', step.sequence);
  push('yas.tenant.id', step.tenantId);
  push('yas.session.id', step.sessionId);
  for (const [key, value] of Object.entries(semanticAttributes(step))) {
    push(key, value);
  }
  // Detail lands under our own prefix even where a semantic name was also
  // emitted: the conventions cover a few fields and the trace carries more,
  // and a reader who wants the router's reasoning should find it.
  for (const [key, value] of Object.entries(step.detail ?? {})) {
    push(`yas.detail.${key}`, value);
  }

  return {
    traceId: toTraceId(step.traceId),
    spanId: toSpanId(step.traceId, step.sequence),
    // Step 0 is the turn itself, so it is the root and has no parent.
    ...(step.sequence === 0 ? {} : { parentSpanId: toSpanId(step.traceId, 0) }),
    name: step.label ? `${step.kind} ${step.label}` : step.kind,
    kind: spanKind(step.kind),
    startTimeUnixNano: nanos(startedAt),
    endTimeUnixNano: nanos(endedAt),
    attributes,
    status: step.succeeded
      ? { code: STATUS_UNSET }
      : {
          code: STATUS_ERROR,
          ...(step.errorMessage === undefined ? {} : { message: step.errorMessage }),
        },
  };
}

export interface ResourceOptions {
  /** How the exporting service names itself. Required by the conventions. */
  readonly serviceName?: string;
  readonly serviceVersion?: string;
  /** `production`, `staging` — whatever the deployment calls itself. */
  readonly environment?: string;
}

const DEFAULT_SERVICE_NAME = 'yas-harness';
const SCOPE_NAME = 'yas-harness';

/** Spans, wrapped in the envelope a collector expects. */
export function toOtlpPayload(
  spans: readonly OtlpSpan[],
  resource: ResourceOptions = {},
): OtlpTracePayload {
  const attributes: OtlpAttribute[] = [
    { key: 'service.name', value: { stringValue: resource.serviceName ?? DEFAULT_SERVICE_NAME } },
    { key: 'telemetry.sdk.name', value: { stringValue: SCOPE_NAME } },
    { key: 'telemetry.sdk.language', value: { stringValue: 'nodejs' } },
  ];
  if (resource.serviceVersion !== undefined) {
    attributes.push({ key: 'service.version', value: { stringValue: resource.serviceVersion } });
  }
  if (resource.environment !== undefined) {
    attributes.push({
      key: 'deployment.environment.name',
      value: { stringValue: resource.environment },
    });
  }

  return {
    resourceSpans: [
      { resource: { attributes }, scopeSpans: [{ scope: { name: SCOPE_NAME }, spans }] },
    ],
  };
}
