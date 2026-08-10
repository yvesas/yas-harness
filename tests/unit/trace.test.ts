// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The trace mechanism itself: numbering, the no-op path, and the promise that
 * a tracing failure never reaches the caller. A trace whose steps are mis-
 * numbered is unreadable, and one that can break a turn is worse than none.
 */

import { describe, expect, it, vi } from 'vitest';

import { RegexSecretRedactor } from '../../src/redaction/regex-secret-redactor.js';
import { RedactingTraceRecorder } from '../../src/telemetry/redacting-trace-recorder.js';
import type { TraceRecorder, RecordedStep } from '../../src/telemetry/trace.js';
import { InMemoryTraceRecorder, TurnTrace } from '../../src/telemetry/trace.js';

const CONTEXT = { tenantId: 'tenant-1', sessionId: 'session-1' };

describe('TurnTrace', () => {
  it('numbers steps from zero, in the order they happened', async () => {
    const recorder = new InMemoryTraceRecorder();
    const trace = new TurnTrace(recorder, CONTEXT);

    await trace.step({ kind: 'input', succeeded: true });
    await trace.step({ kind: 'model_call', succeeded: true });
    await trace.step({ kind: 'reply', succeeded: true });

    expect(
      (await recorder.trace(CONTEXT.tenantId, trace.traceId)).map((step) => [
        step.sequence,
        step.kind,
      ]),
    ).toEqual([
      [0, 'input'],
      [1, 'model_call'],
      [2, 'reply'],
    ]);
  });

  it('joins a trace the caller already started', async () => {
    const recorder = new InMemoryTraceRecorder();

    const first = new TurnTrace(recorder, CONTEXT);
    await first.step({ kind: 'route', succeeded: true });
    const second = new TurnTrace(recorder, { ...CONTEXT, traceId: first.traceId });
    await second.step({ kind: 'input', succeeded: true });

    expect(second.traceId).toBe(first.traceId);
    expect(await recorder.trace(CONTEXT.tenantId, first.traceId)).toHaveLength(2);
  });

  it('gives separate turns separate trace ids', () => {
    const recorder = new InMemoryTraceRecorder();

    const first = new TurnTrace(recorder, CONTEXT);
    const second = new TurnTrace(recorder, CONTEXT);

    expect(first.traceId).not.toBe(second.traceId);
  });

  it('records nothing, and does not throw, without a recorder', async () => {
    const trace = new TurnTrace(undefined, CONTEXT);

    await expect(trace.step({ kind: 'input', succeeded: true })).resolves.toBeUndefined();
    expect(trace.traceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('swallows a recorder failure rather than breaking the turn', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const failing: TraceRecorder = {
        record: () => Promise.reject(new Error('traces table is gone')),
      };
      const trace = new TurnTrace(failing, CONTEXT);

      await expect(trace.step({ kind: 'input', succeeded: true })).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        'failed to record a trace step',
        expect.objectContaining({ kind: 'input' }),
      );
    } finally {
      warn.mockRestore();
    }
  });
});

describe('InMemoryTraceRecorder as a reader', () => {
  it('summarises recent turns the way the Postgres adapter does', async () => {
    const recorder = new InMemoryTraceRecorder();
    const first = new TurnTrace(recorder, CONTEXT);
    await first.step({ kind: 'input', succeeded: true });
    await first.step({ kind: 'reply', label: 'end_turn', succeeded: true });
    const second = new TurnTrace(recorder, CONTEXT);
    await second.step({ kind: 'input', succeeded: true });
    await second.step({ kind: 'tool_call', succeeded: false });

    const recent = await recorder.recent(CONTEXT.tenantId);

    // Newest first, one entry per turn, and the failed one is visible as such —
    // the same contract the database adapter is tested against.
    expect(recent.map((turn) => turn.traceId)).toEqual([second.traceId, first.traceId]);
    expect(recent[0]).toMatchObject({ steps: 2, failed: true, endedAs: null });
    expect(recent[1]).toMatchObject({ steps: 2, failed: false, endedAs: 'end_turn' });
  });

  it('does not show one tenant’s turns to another', async () => {
    const recorder = new InMemoryTraceRecorder();
    await new TurnTrace(recorder, CONTEXT).step({ kind: 'input', succeeded: true });

    expect(await recorder.recent('someone-else')).toHaveLength(0);
  });
});

describe('RedactingTraceRecorder', () => {
  function capture(): { inner: TraceRecorder; steps: RecordedStep[] } {
    const steps: RecordedStep[] = [];
    return {
      steps,
      inner: {
        record: (step) => {
          steps.push(step);
          return Promise.resolve(steps.length - 1);
        },
      },
    };
  }

  it('scrubs secrets out of a tool input before it is stored', async () => {
    const { inner, steps } = capture();
    const recorder = new RedactingTraceRecorder(inner, new RegexSecretRedactor());

    await recorder.record({
      tenantId: 't',
      sessionId: 's',
      traceId: 'trace',
      kind: 'tool_call',
      label: 'fetch',
      succeeded: true,
      detail: { input: { url: 'https://user:s3cr3tpass@example.com/x', page: 2 } },
    });

    expect(steps[0]!.detail).toEqual({
      input: { url: 'https://[REDACTED]@example.com/x', page: 2 },
    });
  });

  it('scrubs the error message and leaves the label alone', async () => {
    const { inner, steps } = capture();
    const recorder = new RedactingTraceRecorder(inner, new RegexSecretRedactor());

    await recorder.record({
      tenantId: 't',
      sessionId: 's',
      traceId: 'trace',
      kind: 'model_call',
      // A label is a name the harness chose — a model, a tool, a module.
      label: 'anthropic/opus',
      succeeded: false,
      errorMessage: 'connect to postgres://user:hunter2@db failed',
    });

    expect(steps[0]!.errorMessage).toBe('connect to postgres://[REDACTED]@db failed');
    expect(steps[0]!.label).toBe('anthropic/opus');
  });
});
