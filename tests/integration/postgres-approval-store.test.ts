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

  it('gathers what is waiting across conversations, oldest first', async () => {
    const sessionB = await createSession(pool, tenantA);
    await store.request([req('call-1', 'send_email')]);
    await store.request([
      {
        tenantId: tenantA,
        sessionId: sessionB,
        toolCallId: 'call-2',
        toolName: 'delete_file',
        input: {},
      },
    ]);

    const waiting = await store.pending(tenantA);

    // The inbox the console needs: one tenant, every conversation, and the
    // longest-blocked turn first.
    expect(waiting.map((approval) => approval.toolName)).toEqual(['send_email', 'delete_file']);
  });

  it('drops an approval from the inbox the moment it is decided', async () => {
    const [created] = await store.request([req('call-1')]);
    await store.approve(tenantA, created!.id, { decidedBy: 'yves' });

    expect(await store.pending(tenantA)).toHaveLength(0);
  });

  it('never shows one tenant what another is waiting on', async () => {
    await store.request([req('call-1')]);

    expect(await store.pending(tenantB)).toHaveLength(0);
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

  it('keeps the risk, the sentence and the rule that gated the call', async () => {
    const [created] = await store.request([
      {
        ...req('call-1', 'send_email'),
        risk: 'high',
        consequence: 'sends a real email to 214 recipients',
        policySource: 'tool.requiresApproval',
      },
    ]);

    const found = await store.find(tenantA, created!.id);

    // The sentence is the whole point: a reviewer approving on the tool name
    // alone is rubber-stamping, and `send_email` says nothing about 214.
    expect(found).toMatchObject({
      risk: 'high',
      consequence: 'sends a real email to 214 recipients',
      policySource: 'tool.requiresApproval',
    });
  });

  it('rates a gated call medium when nobody said, rather than safe', async () => {
    const [created] = await store.request([req('call-1')]);

    expect(created?.risk).toBe('medium');
    expect(created?.consequence).toBeNull();
  });

  it('sends a call back for changes, carrying the note to the model', async () => {
    const [created] = await store.request([req('call-1')]);

    const decided = await store.requestChanges(tenantA, created!.id, {
      decidedBy: 'yves',
      reason: 'only the staging bucket, not production',
    });

    // Not a rejection: the attempt is still alive, the arguments are what was
    // refused, and the note is what the model needs to try again.
    expect(decided.status).toBe('changes_requested');
    expect(decided.reason).toBe('only the staging bucket, not production');
    expect(decided.decidedBy).toBe('yves');
  });

  it('refuses to decide twice, whichever decision came first', async () => {
    const [created] = await store.request([req('call-1')]);
    await store.requestChanges(tenantA, created!.id, { decidedBy: 'yves', reason: 'narrow it' });

    // The pending guard is in the WHERE clause, so it covers the new status
    // without knowing about it.
    await expect(store.approve(tenantA, created!.id, { decidedBy: 'other' })).rejects.toThrow(
      /not pending/,
    );
  });

  it('refuses changes with nothing to change, blank as well as absent', async () => {
    const [created] = await store.request([req('call-1')]);

    // The database refuses it, not the caller: a note-less correction is a
    // loop for the model, which learns its arguments were wrong and not which
    // one. Blank rather than null is the likely mistake — a form posting an
    // empty textarea sends exactly that — so the constraint has to name it.
    await expect(
      store.requestChanges(tenantA, created!.id, { decidedBy: 'yves', reason: '   ' }),
    ).rejects.toThrow(/approvals_changes_need_reason/);

    // And the row is untouched: a refused decision must not half-apply.
    expect((await store.find(tenantA, created!.id))?.status).toBe('pending');
  });

  it('shows the whole inbox newest first, decided rows included', async () => {
    const [first] = await store.request([req('call-1')]);
    const [second] = await store.request([req('call-2')]);
    await store.approve(tenantA, first!.id, { decidedBy: 'yves' });

    const recent = await store.recent(tenantA);

    // `pending` answers "what is blocked on me" and would hide the approved
    // row entirely; the inbox needs both halves to segment them.
    expect(recent.map((a) => a.toolCallId)).toEqual(['call-2', 'call-1']);
    expect(recent.map((a) => a.status)).toEqual(['pending', 'approved']);
    expect(second).toBeDefined();
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
