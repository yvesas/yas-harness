// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The approval queue against a real database.
 *
 * The guarantees that matter are the schema's and the atomic decision: a
 * decision is consistent (a decider and a time, or neither), a tool call is
 * queued at most once, and two operators deciding the same row race on the
 * database rather than both winning.
 */

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ApprovalNotPendingError } from '../../src/approval/approval-store.js';
import { PostgresApprovalStore } from '../../src/approval/postgres-approval-store.js';

const DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!DATABASE_URL)('PostgresApprovalStore', () => {
  let pool: pg.Pool;
  let store: PostgresApprovalStore;
  let tenantA: string;
  let tenantB: string;
  let sessionA: string;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    store = new PostgresApprovalStore(pool);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['appr-%']);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['appr-%']);
    tenantA = await createTenant(pool, 'appr-a');
    tenantB = await createTenant(pool, 'appr-b');
    sessionA = await createSession(pool, tenantA);
  });

  function req(toolCallId: string, toolName = 'delete_file') {
    return {
      tenantId: tenantA,
      sessionId: sessionA,
      toolCallId,
      toolName,
      input: { path: '/x' },
    };
  }

  it('records a pending approval and reads it back', async () => {
    const [created] = await store.request([req('call-1')]);

    const found = await store.find(tenantA, created!.id);

    expect(found).toMatchObject({ toolName: 'delete_file', status: 'pending', decidedBy: null });
    expect(found?.input).toEqual({ path: '/x' });
  });

  it('approves atomically and refuses a second decision', async () => {
    const [created] = await store.request([req('call-1')]);

    const decided = await store.approve(tenantA, created!.id, { decidedBy: 'yves' });
    expect(decided).toMatchObject({ status: 'approved', decidedBy: 'yves' });

    await expect(
      store.reject(tenantA, created!.id, { decidedBy: 'someone' }),
    ).rejects.toBeInstanceOf(ApprovalNotPendingError);
  });

  it('lets only one of two concurrent decisions win', async () => {
    const [created] = await store.request([req('call-1')]);

    const outcomes = await Promise.allSettled([
      store.approve(tenantA, created!.id, { decidedBy: 'a' }),
      store.reject(tenantA, created!.id, { decidedBy: 'b' }),
    ]);

    const fulfilled = outcomes.filter((o) => o.status === 'fulfilled');
    const rejected = outcomes.filter((o) => o.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
  });

  it('refuses to queue the same tool call twice (unique constraint)', async () => {
    await store.request([req('call-1')]);

    await expect(store.request([req('call-1')])).rejects.toThrow(/approvals_tool_call_unique/);
  });

  it('will not let a decision exist without a decider (check constraint)', async () => {
    const [created] = await store.request([req('call-1')]);

    await expect(
      pool.query(`UPDATE approvals SET status = 'approved' WHERE id = $1`, [created!.id]),
    ).rejects.toThrow(/approvals_decision_consistency/);
  });

  it('scopes decisions and reads to the tenant', async () => {
    const [created] = await store.request([req('call-1')]);

    await expect(store.approve(tenantB, created!.id, { decidedBy: 'x' })).rejects.toBeInstanceOf(
      ApprovalNotPendingError,
    );
    expect(await store.find(tenantB, created!.id)).toBeNull();
    expect((await store.find(tenantA, created!.id))?.status).toBe('pending');
  });

  it('finds the approvals gating one turn', async () => {
    await store.request([req('call-1'), req('call-2'), req('call-3')]);

    const found = await store.forToolCalls(tenantA, sessionA, ['call-1', 'call-3']);

    expect(found.map((a) => a.toolCallId).sort()).toEqual(['call-1', 'call-3']);
  });

  it('lists a conversation’s audit trail oldest first', async () => {
    const [first] = await store.request([req('call-1')]);
    await store.request([req('call-2')]);
    await store.reject(tenantA, first!.id, { decidedBy: 'yves', reason: 'no' });

    const trail = await store.list(tenantA, sessionA);

    expect(trail.map((a) => [a.toolCallId, a.status])).toEqual([
      ['call-1', 'rejected'],
      ['call-2', 'pending'],
    ]);
    expect(trail[0]?.reason).toBe('no');
  });

  it('deletes approvals along with the conversation', async () => {
    await store.request([req('call-1')]);

    await pool.query('DELETE FROM sessions WHERE id = $1', [sessionA]);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM approvals WHERE session_id = $1',
      [sessionA],
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
