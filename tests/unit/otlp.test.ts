// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Traces, as OpenTelemetry sees them.
 *
 * Two things are being checked. The translation: a step becomes a span whose
 * ids, times and attributes a collector will accept and a backend will group.
 * And the export: that a collector being slow, rude or absent costs the turn
 * nothing.
 */

import { describe, expect, it, vi } from 'vitest';

import { OtlpTraceRecorder } from '../../src/telemetry/otlp-trace-recorder.js';
import type { OtlpAttribute, OtlpSpan } from '../../src/telemetry/otlp.js';
import { toOtlpPayload, toSpan, toSpanId, toTraceId } from '../../src/telemetry/otlp.js';
import type { TraceRecorder, TraceStep } from '../../src/telemetry/trace.js';
import { InMemoryTraceRecorder } from '../../src/telemetry/trace.js';

const TRACE_ID = '0195f1a0-7b3c-4d2e-8f10-a1b2c3d4e5f6';
const ENDED_AT = new Date('2026-08-03T12:00:00.000Z');

function step(overrides: Partial<TraceStep> = {}): TraceStep {
  return {
    tenantId: 'tenant-1',
    sessionId: 'session-1',
    traceId: TRACE_ID,
    sequence: 1,
    kind: 'model_call',
    label: 'claude-opus-5',
    durationMs: 250,
    succeeded: true,
    ...overrides,
  };
}

function attributes(span: OtlpSpan): Record<string, unknown> {
  const flat: Record<string, unknown> = {};
  for (const { key, value } of span.attributes as OtlpAttribute[]) {
    flat[key] = Object.values(value)[0];
  }
  return flat;
}

describe('trace steps as OTLP spans', () => {
  it('carries a UUID trace id through as the 16 bytes OTLP wants', () => {
    // Unhyphenated, a UUID already is a valid OTLP trace id — mangling it would
    // sever the link between a stored trace and its exported one.
    expect(toTraceId(TRACE_ID)).toBe('0195f1a07b3c4d2e8f10a1b2c3d4e5f6');
  });

  it('still produces a valid trace id from something that is not a UUID', () => {
    // Callers may share a trace id across components, so it is not ours to
    // assume. A collector rejects the whole batch over one malformed id.
    const derived = toTraceId('turn-42');
    expect(derived).toMatch(/^[0-9a-f]{32}$/);
    expect(toTraceId('turn-42')).toBe(derived); // and stable
  });

  it('derives span ids, so the same step is never two spans', () => {
    const once = toSpan(step(), { endedAt: ENDED_AT });
    const again = toSpan(step(), { endedAt: new Date('2026-08-03T13:00:00.000Z') });

    // Re-exported an hour later — same span, updated. A random id would have
    // left the backend showing the turn twice.
    expect(again.spanId).toBe(once.spanId);
    expect(toSpanId(TRACE_ID, 1)).not.toBe(toSpanId(TRACE_ID, 2));
  });

  it('hangs every step off the first one, which is the turn itself', () => {
    const root = toSpan(step({ sequence: 0, kind: 'input' }), { endedAt: ENDED_AT });
    const child = toSpan(step({ sequence: 3 }), { endedAt: ENDED_AT });

    expect(root.parentSpanId).toBeUndefined();
    // Derivable from the trace id alone: nothing has to be remembered between
    // one step being recorded and the next.
    expect(child.parentSpanId).toBe(root.spanId);
  });

  it('places the span in time using the duration it was given', () => {
    const span = toSpan(step({ durationMs: 250 }), { endedAt: ENDED_AT });

    expect(span.endTimeUnixNano).toBe('1785758400000000000');
    expect(BigInt(span.endTimeUnixNano) - BigInt(span.startTimeUnixNano)).toBe(250_000_000n);
  });

  it('gives a step with no duration an instant', () => {
    const { durationMs: _ignored, ...instant } = step({ kind: 'input' });
    const span = toSpan(instant, { endedAt: ENDED_AT });

    // Better than inventing a length: a zero-width span reads as a point in
    // time, which is what an input actually is.
    expect(span.startTimeUnixNano).toBe(span.endTimeUnixNano);
  });

  it('speaks the GenAI conventions for a model call', () => {
    const span = toSpan(
      step({
        detail: {
          stopReason: 'end_turn',
          inputTokens: 1200,
          outputTokens: 80,
          cachedInputTokens: 1024,
          iteration: 1,
        },
      }),
      { endedAt: ENDED_AT },
    );

    // The point of the conventions: a backend's model dashboards work on these
    // spans with nobody configuring a mapping.
    expect(attributes(span)).toMatchObject({
      'gen_ai.operation.name': 'chat',
      'gen_ai.response.model': 'claude-opus-5',
      'gen_ai.response.finish_reasons': 'end_turn',
      'gen_ai.usage.input_tokens': '1200',
      'gen_ai.usage.output_tokens': '80',
      'gen_ai.usage.cache_read_input_tokens': '1024',
    });
    // And the rest of the detail survives under our own prefix.
    expect(attributes(span)['yas.detail.iteration']).toBe('1');
  });

  it('names the tool on a tool call', () => {
    const span = toSpan(step({ kind: 'tool_call', label: 'send_email' }), { endedAt: ENDED_AT });

    expect(attributes(span)).toMatchObject({
      'gen_ai.operation.name': 'execute_tool',
      'gen_ai.tool.name': 'send_email',
    });
    expect(span.kind).toBe(1); // internal: a tool runs in this process
  });

  it('leaves a harness concept under our prefix instead of inventing a name', () => {
    const span = toSpan(step({ kind: 'route', label: 'billing' }), { endedAt: ENDED_AT });

    // There is no `gen_ai` name for routing. A made-up one would collide with
    // whatever the conventions eventually choose.
    expect(attributes(span)['gen_ai.operation.name']).toBeUndefined();
    expect(attributes(span)['yas.step.kind']).toBe('route');
    expect(span.name).toBe('route billing');
  });

  it('keeps the tenant on the span, since it is the dimension anyone filters by', () => {
    expect(attributes(toSpan(step(), { endedAt: ENDED_AT }))).toMatchObject({
      'yas.tenant.id': 'tenant-1',
      'yas.session.id': 'session-1',
      'yas.step.sequence': '1',
    });
  });

  it('marks a failed step as an error, with what went wrong', () => {
    const span = toSpan(step({ succeeded: false, errorMessage: 'provider timed out' }), {
      endedAt: ENDED_AT,
    });

    expect(span.status).toEqual({ code: 2, message: 'provider timed out' });
    // Unset, not OK: the convention reserves OK for an explicit assertion.
    expect(toSpan(step(), { endedAt: ENDED_AT }).status.code).toBe(0);
  });

  it('sends large integers as strings', () => {
    const span = toSpan(step({ detail: { total: Number.MAX_SAFE_INTEGER } }), {
      endedAt: ENDED_AT,
    });

    // A JSON number stops being the integer that was sent past 2^53, and token
    // counts are int64 on the wire.
    expect(attributes(span)['yas.detail.total']).toBe('9007199254740991');
  });

  it('drops a null attribute rather than sending it', () => {
    const span = toSpan(step({ sessionId: null, detail: { reason: null } }), {
      endedAt: ENDED_AT,
    });

    expect(Object.keys(attributes(span))).not.toContain('yas.session.id');
    expect(Object.keys(attributes(span))).not.toContain('yas.detail.reason');
  });

  it('names the service on the resource, as the conventions require', () => {
    const payload = toOtlpPayload([toSpan(step(), { endedAt: ENDED_AT })], {
      serviceName: 'tutor-api',
      serviceVersion: '1.2.0',
      environment: 'production',
    });

    const resource = attributes({
      attributes: payload.resourceSpans[0]!.resource.attributes,
    } as OtlpSpan);
    expect(resource).toMatchObject({
      'service.name': 'tutor-api',
      'service.version': '1.2.0',
      'deployment.environment.name': 'production',
    });
    expect(payload.resourceSpans[0]!.scopeSpans[0]!.spans).toHaveLength(1);
  });
});

/** A collector that records what it was sent and answers however the test says. */
function collector(
  answer: () => { ok: boolean; status: number } | Error = () => ({
    ok: true,
    status: 200,
  }),
) {
  const requests: { url: string; body: unknown }[] = [];
  return {
    requests,
    get spans(): OtlpSpan[] {
      return requests.flatMap(
        (request) =>
          (request.body as { resourceSpans: { scopeSpans: { spans: OtlpSpan[] }[] }[] })
            .resourceSpans[0]!.scopeSpans[0]!.spans,
      );
    },
    send: (url: string, init: RequestInit) => {
      requests.push({ url, body: JSON.parse(init.body as string) });
      const outcome = answer();
      return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
    },
  };
}

describe('OTLP export', () => {
  it('appends the path the OTLP specification defines', async () => {
    const sink = collector();
    const recorder = new OtlpTraceRecorder(undefined, {
      endpoint: 'http://collector:4318/',
      send: sink.send,
    });

    await recorder.record(step());
    await recorder.flush();

    expect(sink.requests[0]?.url).toBe('http://collector:4318/v1/traces');
  });

  it('leaves an endpoint that already names the path alone', async () => {
    const sink = collector();
    const recorder = new OtlpTraceRecorder(undefined, {
      endpoint: 'http://collector:4318/v1/traces',
      send: sink.send,
    });

    await recorder.record(step());
    await recorder.flush();

    // Most collector documentation prints the full path; doubling it would
    // 404 against a working collector.
    expect(sink.requests[0]?.url).toBe('http://collector:4318/v1/traces');
  });

  it('batches instead of sending a request per step', async () => {
    const sink = collector();
    const recorder = new OtlpTraceRecorder(undefined, {
      endpoint: 'http://collector:4318',
      maxBatchSize: 3,
      send: sink.send,
    });

    for (let sequence = 0; sequence < 3; sequence += 1) {
      await recorder.record(step({ sequence }));
    }

    // A full batch goes on its own, without waiting for the timer.
    await vi.waitFor(() => {
      expect(sink.requests).toHaveLength(1);
    });
    expect(sink.spans).toHaveLength(3);
  });

  it('still stores the step when the collector is down', async () => {
    const store = new InMemoryTraceRecorder();
    const errors: { error: Error; dropped: number }[] = [];
    const recorder = new OtlpTraceRecorder(store, {
      endpoint: 'http://collector:4318',
      send: () => Promise.reject(new Error('ECONNREFUSED')),
      onError: (error, dropped) => errors.push({ error, dropped }),
    });

    await recorder.record(step());
    await recorder.flush();

    // The durable path is unaffected, and the failure is reported rather than
    // swallowed into nothing.
    expect(store.steps).toHaveLength(1);
    expect(errors[0]?.error.message).toBe('ECONNREFUSED');
    expect(errors[0]?.dropped).toBe(1);
  });

  it('does not fail the turn when the collector refuses the batch', async () => {
    const errors: Error[] = [];
    const recorder = new OtlpTraceRecorder(undefined, {
      endpoint: 'http://collector:4318',
      send: () => Promise.resolve({ ok: false, status: 503 }),
      onError: (error) => errors.push(error),
    });

    await expect(recorder.record(step())).resolves.toBeUndefined();
    await expect(recorder.flush()).resolves.toBeUndefined();
    expect(errors[0]?.message).toMatch(/503/);
  });

  it('exports even when the store rejects', async () => {
    const sink = collector();
    const broken: TraceRecorder = {
      record: () => Promise.reject(new Error('database is read-only')),
    };
    const recorder = new OtlpTraceRecorder(broken, {
      endpoint: 'http://collector:4318',
      send: sink.send,
    });

    // The store's failure is still the caller's to see...
    await expect(recorder.record(step())).rejects.toThrow('read-only');
    await recorder.flush();
    // ...and it did not also cost the export, which is the one destination
    // still working.
    expect(sink.spans).toHaveLength(1);
  });

  it('drops the oldest spans rather than growing without bound', async () => {
    const sink = collector();
    const errors: { error: Error; dropped: number }[] = [];
    const recorder = new OtlpTraceRecorder(undefined, {
      endpoint: 'http://collector:4318',
      maxBatchSize: 1000, // never full, so nothing leaves on its own
      maxQueueSize: 2,
      send: sink.send,
      onError: (error, dropped) => errors.push({ error, dropped }),
    });

    for (let sequence = 0; sequence < 4; sequence += 1) {
      await recorder.record(step({ sequence }));
    }
    await recorder.flush();

    // Telemetry must not be what kills the process it observes. The newest
    // spans survive — they describe what is happening now.
    expect(sink.spans).toHaveLength(2);
    expect(sink.spans.map((span) => span.spanId)).toEqual([
      toSpanId(TRACE_ID, 2),
      toSpanId(TRACE_ID, 3),
    ]);
    expect(errors.map((entry) => entry.dropped)).toEqual([1, 1]);
  });

  it('sends what is waiting when it is closed', async () => {
    const sink = collector();
    const recorder = new OtlpTraceRecorder(undefined, {
      endpoint: 'http://collector:4318',
      maxBatchSize: 100,
      send: sink.send,
    });

    await recorder.record(step());
    await recorder.close();

    // The last spans of a turn are usually the ones explaining the shutdown.
    expect(sink.spans).toHaveLength(1);
  });

  it('keeps storing after it is closed, and stops exporting', async () => {
    const sink = collector();
    const store = new InMemoryTraceRecorder();
    const recorder = new OtlpTraceRecorder(store, {
      endpoint: 'http://collector:4318',
      send: sink.send,
    });

    await recorder.close();
    await recorder.record(step());
    await recorder.flush();

    // A closed exporter is not a broken recorder: the turn in flight still
    // gets written down.
    expect(store.steps).toHaveLength(1);
    expect(sink.requests).toHaveLength(0);
  });

  it('survives a reporter that throws', async () => {
    const recorder = new OtlpTraceRecorder(undefined, {
      endpoint: 'http://collector:4318',
      send: () => Promise.reject(new Error('down')),
      onError: () => {
        throw new Error('the logger is broken too');
      },
    });

    await recorder.record(step());
    // Nothing about telling someone about a failure should become one.
    await expect(recorder.flush()).resolves.toBeUndefined();
  });
});
