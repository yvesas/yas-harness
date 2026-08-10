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
import type { RecordedStep, TraceStep } from '../../src/telemetry/trace.js';

const DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!DATABASE_URL)('PostgresTraceRecorder', () => {
  let pool: pg.Pool;
  let recorder: PostgresTraceRecorder;
  let tenantA: string;
  let tenantB: string;
  let sessionA: string;

  const TRACE = '55555555-5555-4555-8555-555555555555';
  const JOINED = '66666666-6666-4666-8666-666666666666';

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

  function step(overrides: Partial<RecordedStep> = {}): RecordedStep {
    return {
      tenantId: tenantA,
      sessionId: sessionA,
      traceId: TRACE,
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

  it('numbers a turn in the order it was written, and says where each landed', async () => {
    // The position is the recorder's to assign — created_at cannot sort these,
    // since steps written in one transaction share a timestamp.
    const first = await recorder.record(step({ kind: 'input' }));
    const second = await recorder.record(step({ kind: 'model_call' }));
    const third = await recorder.record(step({ kind: 'reply' }));

    expect([first, second, third]).toEqual([0, 1, 2]);
    expect((await recorder.trace(tenantA, TRACE)).map((entry) => entry.kind)).toEqual([
      'input',
      'model_call',
      'reply',
    ]);
  });

  it('cannot be made to put two steps in one position', async () => {
    // The unique constraint still guards the table, but nothing a caller does
    // can trip it any more: writing the same step twice makes two positions,
    // which is the honest record of two writes.
    await recorder.record(step({ kind: 'input' }));
    await recorder.record(step({ kind: 'input' }));

    const steps = await recorder.trace(tenantA, TRACE);
    expect(steps.map((one) => one.sequence)).toEqual([0, 1]);
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

  it('summarises recent turns, newest first, one row per turn', async () => {
    const older = '77777777-7777-4777-8777-777777777777';
    await recorder.record(step({ traceId: older, kind: 'input' }));
    await recorder.record(step({ traceId: older, kind: 'reply', label: 'end_turn' }));
    await recorder.record(step({ kind: 'input' }));
    await recorder.record(step({ kind: 'tool_call', succeeded: false }));
    await recorder.record(step({ kind: 'reply', label: 'iteration_limit' }));

    const recent = await recorder.recent(tenantA);

    expect(recent).toHaveLength(2);
    expect(recent[0]).toMatchObject({
      traceId: TRACE,
      steps: 3,
      endedAs: 'iteration_limit',
      // A list of turns exists to surface the ones worth opening.
      failed: true,
    });
    expect(recent[1]).toMatchObject({ traceId: older, steps: 2, failed: false });
  });

  it('narrows recent turns to one conversation, and respects a limit', async () => {
    const other = await createSession(pool, tenantA);
    await recorder.record(step());
    await recorder.record(
      step({ traceId: '88888888-8888-4888-8888-888888888888', sessionId: other }),
    );

    expect(await recorder.recent(tenantA, { sessionId: other })).toHaveLength(1);
    expect(await recorder.recent(tenantA, { limit: 1 })).toHaveLength(1);
  });

  it('hides another tenant’s turns from the list', async () => {
    await recorder.record(step());
    await recorder.record(step({ tenantId: tenantB, sessionId: null }));

    expect(await recorder.recent(tenantB)).toHaveLength(1);
    expect((await recorder.recent(tenantB))[0]?.sessionId).toBeNull();
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

  it('continues one trace across two writers instead of colliding', async () => {
    // The router opens a trace and the agent continues it — which is what
    // `AgentTurn.traceId` is for. Both used to count from zero, so the agent's
    // first step lost a unique-constraint race and was dropped: every routed
    // turn was silently missing its `input` while the trace still read as
    // though nothing were absent.
    const base = { tenantId: tenantA, sessionId: sessionA, traceId: JOINED, succeeded: true };

    await recorder.record({ ...base, kind: 'route', label: 'notes' });
    await recorder.record({ ...base, kind: 'input' });
    await recorder.record({ ...base, kind: 'model_call', label: 'a-model' });

    const steps = await recorder.trace(tenantA, JOINED);

    expect(steps.map((one) => one.kind)).toEqual(['route', 'input', 'model_call']);
    expect(steps.map((one) => one.sequence)).toEqual([0, 1, 2]);
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
