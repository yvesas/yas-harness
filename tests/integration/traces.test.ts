// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Traces against a real database.
 *
 * The guarantees that matter here are the schema's, and one of them is the
 * opposite of `model_usage`'s: a usage row outlives the conversation it billed,
 * a trace does not — it holds the user's own words, so deleting the
 * conversation must delete it. The rest is ordering and isolation.
 */

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresTraceRecorder } from '../../src/telemetry/postgres-trace-recorder.js';
import type { TraceStep } from '../../src/telemetry/trace.js';

const DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!DATABASE_URL)('PostgresTraceRecorder', () => {
  let pool: pg.Pool;
  let recorder: PostgresTraceRecorder;
  let tenantA: string;
  let tenantB: string;
  let sessionA: string;

  const TRACE = '55555555-5555-4555-8555-555555555555';

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    recorder = new PostgresTraceRecorder(pool);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['trace-%']);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['trace-%']);
    tenantA = await createTenant(pool, 'trace-a');
    tenantB = await createTenant(pool, 'trace-b');
    sessionA = await createSession(pool, tenantA);
  });

  function step(overrides: Partial<TraceStep> = {}): TraceStep {
    return {
      tenantId: tenantA,
      sessionId: sessionA,
      traceId: TRACE,
      sequence: 0,
      kind: 'input',
      succeeded: true,
      ...overrides,
    };
  }

  it('round-trips a step with everything it carries', async () => {
    await recorder.record(
      step({
        kind: 'tool_call',
        label: 'get_weather',
        durationMs: 42,
        detail: { input: { city: 'Lisbon' }, retries: 0 },
      }),
    );

    expect(await recorder.trace(tenantA, TRACE)).toEqual([
      {
        tenantId: tenantA,
        sessionId: sessionA,
        traceId: TRACE,
        sequence: 0,
        kind: 'tool_call',
        label: 'get_weather',
        durationMs: 42,
        succeeded: true,
        detail: { input: { city: 'Lisbon' }, retries: 0 },
      },
    ]);
  });

  it('returns a turn in sequence order, however it was written', async () => {
    await recorder.record(step({ sequence: 2, kind: 'reply' }));
    await recorder.record(step({ sequence: 0, kind: 'input' }));
    await recorder.record(step({ sequence: 1, kind: 'model_call' }));

    // Written out of order on purpose: created_at cannot sort these — steps
    // written in one transaction share a timestamp.
    expect((await recorder.trace(tenantA, TRACE)).map((entry) => entry.kind)).toEqual([
      'input',
      'model_call',
      'reply',
    ]);
  });

  it('refuses two steps at the same position in a turn', async () => {
    await recorder.record(step({ sequence: 0 }));

    // A repeated sequence would make a trace silently misread, so it is a
    // write that fails rather than a row that lands.
    await expect(recorder.record(step({ sequence: 0, kind: 'reply' }))).rejects.toThrow(
      /traces_step_unique/,
    );
  });

  it('refuses a kind the agent could not have produced', async () => {
    await expect(recorder.record(step({ kind: 'daydream' as TraceStep['kind'] }))).rejects.toThrow(
      /traces_kind_check/,
    );
  });

  it('records a module asking another for context', async () => {
    await recorder.record(
      step({
        kind: 'context_request',
        label: 'planner → ledger',
        succeeded: false,
        detail: { requester: 'planner', owner: 'ledger', granted: false, reason: 'no' },
      }),
    );

    // The only step where data crosses a module boundary, so it lives in the
    // same trace as the turn that caused it rather than a table of its own.
    expect((await recorder.trace(tenantA, TRACE))[0]).toMatchObject({
      kind: 'context_request',
      succeeded: false,
    });
  });

  it('records a step outside any conversation', async () => {
    // A standalone routing call has no session to belong to.
    await recorder.record(step({ sessionId: null, kind: 'route', label: 'finance' }));

    expect((await recorder.trace(tenantA, TRACE))[0]?.sessionId).toBeNull();
  });

  it('hides another tenant’s trace, even with the same trace id', async () => {
    await recorder.record(step());
    await recorder.record(step({ tenantId: tenantB, sessionId: null, kind: 'route' }));

    expect(await recorder.trace(tenantA, TRACE)).toHaveLength(1);
    expect((await recorder.trace(tenantA, TRACE))[0]?.tenantId).toBe(tenantA);
  });

  it('refuses at the database level to attach a step to another tenant’s session', async () => {
    await expect(recorder.record(step({ tenantId: tenantB }))).rejects.toThrow(
      /traces_session_fkey/,
    );
  });

  it('deletes the trace when the conversation is deleted', async () => {
    await recorder.record(step());

    await pool.query('DELETE FROM sessions WHERE id = $1', [sessionA]);

    // The opposite of model_usage, deliberately: a trace carries the user's
    // own words, so it must not outlive the conversation it describes.
    expect(await recorder.trace(tenantA, TRACE)).toHaveLength(0);
  });

  it('deletes traces along with the tenant', async () => {
    await recorder.record(step({ sessionId: null }));

    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantA]);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM traces WHERE tenant_id = $1',
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
