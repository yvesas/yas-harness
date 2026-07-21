// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Model usage against a real database.
 *
 * Cost is money, so the guarantees that matter are the schema's: no negative
 * spend, no failure without a reason, no cross-tenant row, and no loss of
 * precision on numbers small enough to round to zero in cents.
 */

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { ModelUsageRecord } from '../../src/telemetry/model-usage.js';
import { PostgresUsageRecorder } from '../../src/telemetry/postgres-usage-recorder.js';

const DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!DATABASE_URL)('PostgresUsageRecorder', () => {
  let pool: pg.Pool;
  let recorder: PostgresUsageRecorder;
  let tenantA: string;
  let tenantB: string;
  let sessionA: string;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    recorder = new PostgresUsageRecorder(pool);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['usage-%']);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['usage-%']);
    tenantA = await createTenant(pool, 'usage-a');
    tenantB = await createTenant(pool, 'usage-b');
    sessionA = await createSession(pool, tenantA);
  });

  function usage(overrides: Partial<ModelUsageRecord> = {}): ModelUsageRecord {
    return {
      tenantId: tenantA,
      sessionId: sessionA,
      task: 'reasoning',
      modelReference: 'anthropic/opus',
      provider: 'anthropic',
      model: 'claude-opus-4-8',
      tier: 'premium',
      usage: { inputTokens: 1000, outputTokens: 500, cachedInputTokens: 0 },
      costUsd: 0.0175,
      latencyMs: 900,
      attempts: 1,
      succeeded: true,
      ...overrides,
    };
  }

  it('records a call and reports the spend', async () => {
    await recorder.record(usage());

    expect(await recorder.spend(tenantA)).toEqual({
      totalCostUsd: 0.0175,
      calls: 1,
      inputTokens: 1000,
      outputTokens: 500,
    });
  });

  it('keeps sub-cent precision, which is most single calls', async () => {
    await recorder.record(usage({ costUsd: 0.00000123 }));

    const { totalCostUsd } = await recorder.spend(tenantA);
    expect(totalCostUsd).toBeCloseTo(0.00000123, 8);
  });

  it('narrows spend to one conversation', async () => {
    const otherSession = await createSession(pool, tenantA);
    await recorder.record(usage({ costUsd: 1 }));
    await recorder.record(usage({ sessionId: otherSession, costUsd: 2 }));

    expect((await recorder.spend(tenantA, sessionA)).totalCostUsd).toBe(1);
    expect((await recorder.spend(tenantA)).totalCostUsd).toBe(3);
  });

  it('does not leak another tenant’s spend', async () => {
    await recorder.record(usage({ costUsd: 5 }));

    expect(await recorder.spend(tenantB)).toMatchObject({ totalCostUsd: 0, calls: 0 });
  });

  it('records a failed attempt with its reason', async () => {
    await recorder.record(
      usage({
        succeeded: false,
        errorMessage: 'groq responded 429',
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
        costUsd: 0,
      }),
    );

    const { rows } = await pool.query<{ error_message: string; succeeded: boolean }>(
      'SELECT error_message, succeeded FROM model_usage WHERE tenant_id = $1',
      [tenantA],
    );
    expect(rows[0]).toMatchObject({ succeeded: false, error_message: 'groq responded 429' });
  });

  it('refuses a failure with no reason recorded', async () => {
    await expect(
      pool.query(
        `INSERT INTO model_usage (
           tenant_id, task, model_reference, provider, model, tier,
           input_tokens, output_tokens, cached_input_tokens, cost_usd,
           latency_ms, attempts, succeeded
         ) VALUES ($1, 'simple', 'x', 'y', 'z', 'cheap', 0, 0, 0, 0, 1, 1, false)`,
        [tenantA],
      ),
    ).rejects.toThrow(/model_usage_error_matches_outcome/);
  });

  it('refuses a negative cost', async () => {
    await expect(recorder.record(usage({ costUsd: -1 }))).rejects.toThrow(/model_usage_cost_check/);
  });

  it('keeps the billing record when the conversation is deleted', async () => {
    await recorder.record(usage({ costUsd: 3 }));

    await pool.query('DELETE FROM sessions WHERE id = $1', [sessionA]);

    // The row survives with session_id cleared: spend history outlives the
    // conversation that produced it.
    expect(await recorder.spend(tenantA)).toMatchObject({ totalCostUsd: 3, calls: 1 });
  });

  it('deletes usage along with the tenant', async () => {
    await recorder.record(usage());

    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantA]);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM model_usage WHERE tenant_id = $1',
      [tenantA],
    );
    expect(rows[0]?.count).toBe('0');
  });
});

async function createTenant(pool: pg.Pool, slug: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
    [slug, slug],
  );
  return rows[0]!.id;
}

async function createSession(pool: pg.Pool, tenantId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "INSERT INTO sessions (tenant_id, persona_id) VALUES ($1, 'default') RETURNING id",
    [tenantId],
  );
  return rows[0]!.id;
}
