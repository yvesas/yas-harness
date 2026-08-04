// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The same money, grouped.
 *
 * Asked for by the console's Cost page, which could otherwise show one
 * aggregate and say nothing about where it went — which is the question
 * anyone actually has when the number looks wrong.
 *
 * The cases worth pinning are the ones about not inventing an answer: a call
 * that belongs to no session, and a dimension the in-memory adapter has no
 * clock to compute.
 */

import { describe, expect, it } from 'vitest';

import { InMemoryUsageRecorder, type ModelUsageRecord } from '../../src/telemetry/model-usage.js';

const TENANT = 'tenant-1';

function record(overrides: Partial<ModelUsageRecord> = {}): ModelUsageRecord {
  return {
    tenantId: TENANT,
    sessionId: 'session-1',
    task: 'simple',
    modelReference: 'anthropic/opus',
    provider: 'anthropic',
    model: 'opus',
    tier: 'premium',
    usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 10 },
    costUsd: 0.01,
    latencyMs: 100,
    attempts: 1,
    succeeded: true,
    ...overrides,
  };
}

async function recorderWith(records: ModelUsageRecord[]): Promise<InMemoryUsageRecorder> {
  const recorder = new InMemoryUsageRecorder();
  for (const one of records) {
    await recorder.record(one);
  }
  return recorder;
}

describe('spend, grouped', () => {
  it('adds up the money per model, dearest first', async () => {
    const recorder = await recorderWith([
      record({ modelReference: 'groq/llama', costUsd: 0.001 }),
      record({ modelReference: 'anthropic/opus', costUsd: 0.05 }),
      record({ modelReference: 'anthropic/opus', costUsd: 0.03 }),
    ]);

    const slices = await recorder.breakdown(TENANT, { by: 'model' });

    // Dearest first, because the question behind the page is "where did it go".
    expect(slices.map((slice) => slice.key)).toEqual(['anthropic/opus', 'groq/llama']);
    expect(slices[0]).toMatchObject({ costUsd: 0.08, calls: 2, inputTokens: 200 });
  });

  it('groups by task, which is what says whether triage stayed cheap', async () => {
    const recorder = await recorderWith([
      record({ task: 'routing', costUsd: 0.0001 }),
      record({ task: 'reasoning', costUsd: 0.09 }),
    ]);

    expect((await recorder.breakdown(TENANT, { by: 'task' })).map((slice) => slice.key)).toEqual([
      'reasoning',
      'routing',
    ]);
  });

  it('leaves a call outside a conversation out of a session breakdown', async () => {
    const recorder = await recorderWith([
      record({ sessionId: 'session-1' }),
      // A routing decision made before a session exists.
      record({ sessionId: null, costUsd: 0.5 }),
    ]);

    const slices = await recorder.breakdown(TENANT, { by: 'session' });

    // Bucketing it under "none" would invent a session that never existed —
    // and it would be the biggest row on the page, unclickable.
    expect(slices.map((slice) => slice.key)).toEqual(['session-1']);
  });

  it('never mixes one tenant’s money into another’s', async () => {
    const recorder = await recorderWith([
      record({ tenantId: TENANT, costUsd: 0.01 }),
      record({ tenantId: 'tenant-2', costUsd: 9 }),
    ]);

    const slices = await recorder.breakdown(TENANT, { by: 'model' });

    expect(slices).toHaveLength(1);
    expect(slices[0]?.costUsd).toBe(0.01);
  });

  it('caps how many groups it returns', async () => {
    const recorder = await recorderWith(
      Array.from({ length: 30 }, (_unused, index) =>
        record({ modelReference: `model-${String(index)}`, costUsd: index / 1000 }),
      ),
    );

    const slices = await recorder.breakdown(TENANT, { by: 'model', limit: 5 });

    expect(slices).toHaveLength(5);
    // The cap keeps the dearest, not the first seen — a truncated list that
    // dropped the expensive rows would be worse than no list.
    expect(slices[0]?.key).toBe('model-29');
  });

  it('answers nothing for a day breakdown it cannot compute', async () => {
    const recorder = await recorderWith([record()]);

    // In memory there is no `recordedAt`, so there is no day to group by.
    // Bucketing everything under today would read as a real answer.
    expect(await recorder.breakdown(TENANT, { by: 'day' })).toEqual([]);
  });
});

describe('what compression saved', () => {
  it('says nothing was compressed rather than saying nothing was saved', async () => {
    const recorder = await recorderWith([record()]);

    // Null and zero are different answers: "compression was never on" versus
    // "it ran and paid for nothing". A page should be able to tell them apart.
    expect(await recorder.savings(TENANT)).toBeNull();
  });

  it('reports both sides, not a ratio', async () => {
    const recorder = await recorderWith([
      record({ compression: { beforeTokens: 1000, afterTokens: 600 } }),
      record({ compression: { beforeTokens: 500, afterTokens: 400 } }),
      record(),
    ]);

    // A ratio would hide how much of the traffic compression even touched:
    // two calls of three here.
    expect(await recorder.savings(TENANT)).toEqual({
      calls: 2,
      beforeTokens: 1500,
      afterTokens: 1000,
    });
  });
});
