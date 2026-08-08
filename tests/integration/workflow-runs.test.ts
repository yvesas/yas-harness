// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Workflow runs against a real database.
 *
 * The unit tests prove the runner's decisions; this proves the thing those
 * decisions rest on — that a paused run is *durable*. If the row does not
 * survive the process, the pause is a promise rather than a mechanism, and the
 * first deploy during a waiting run loses the work.
 *
 * Also here: the tenant boundary, and the composite foreign key that stops a
 * step of one tenant's run pointing at another tenant's session.
 */

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresWorkflowRunStore } from '../../src/workflows/postgres-workflow-run-store.js';

const DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!DATABASE_URL)('PostgresWorkflowRunStore', () => {
  let pool: pg.Pool;
  let store: PostgresWorkflowRunStore;
  let tenantA: string;
  let tenantB: string;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['wf-%']);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['wf-%']);
    tenantA = await createTenant(pool, 'wf-a');
    tenantB = await createTenant(pool, 'wf-b');
    store = new PostgresWorkflowRunStore(pool);
  });

  async function startRun(tenantId: string) {
    return store.start({ tenantId, workflowId: 'weekly', input: 'pricing' });
  }

  it('keeps a paused run, so waiting survives the process that started it', async () => {
    const run = await startRun(tenantA);
    await store.recordStep({
      tenantId: tenantA,
      runId: run.id,
      stepId: 'publish',
      agentId: 'publisher',
      prompt: 'Post this: the notes',
      status: 'awaiting_approval',
      awaiting: 'step',
    });
    await store.setStatus(tenantA, run.id, 'awaiting_approval');

    // A different store instance, as a restarted process would have.
    const afterRestart = new PostgresWorkflowRunStore(pool);
    const reread = await afterRestart.find(tenantA, run.id);
    const [step] = await afterRestart.steps(tenantA, run.id);

    expect(reread?.status).toBe('awaiting_approval');
    expect(reread?.finishedAt).toBeNull();
    expect(step?.awaiting).toBe('step');
    // The prompt as rendered, not the template: the config can be edited
    // between the pause and the decision.
    expect(step?.prompt).toBe('Post this: the notes');
  });

  it('keeps one row per step, however often the step is written', async () => {
    const run = await startRun(tenantA);
    const base = {
      tenantId: tenantA,
      runId: run.id,
      stepId: 'research',
      agentId: 'researcher',
      prompt: 'Look into pricing',
    };

    await store.recordStep({ ...base, status: 'running' });
    await store.recordStep({ ...base, status: 'awaiting_approval', awaiting: 'tool' });
    await store.recordStep({ ...base, status: 'completed', output: 'the notes' });

    const steps = await store.steps(tenantA, run.id);

    // A step that paused and resumed is one step that took a while.
    expect(steps).toHaveLength(1);
    expect(steps[0]?.status).toBe('completed');
    expect(steps[0]?.awaiting).toBeNull();
    expect(steps[0]?.finishedAt).not.toBeNull();
  });

  it('keeps the session a step ran in when a later write does not carry it', async () => {
    const run = await startRun(tenantA);
    const session = await createSession(pool, tenantA);
    const base = {
      tenantId: tenantA,
      runId: run.id,
      stepId: 'research',
      agentId: 'researcher',
      prompt: 'x',
    };

    await store.recordStep({ ...base, status: 'running', sessionId: session });
    await store.recordStep({ ...base, status: 'completed', output: 'done' });

    const [step] = await store.steps(tenantA, run.id);
    // Otherwise a resume could not find the conversation the held call is in.
    expect(step?.sessionId).toBe(session);
  });

  it('stamps an end only on a run that reached one', async () => {
    const run = await startRun(tenantA);

    const waiting = await store.setStatus(tenantA, run.id, 'awaiting_approval');
    const failed = await store.setStatus(tenantA, run.id, 'failed', 'the model refused');

    expect(waiting.finishedAt).toBeNull();
    expect(failed.finishedAt).not.toBeNull();
    expect(failed.error).toBe('the model refused');
  });

  it('never reaches another tenant’s run', async () => {
    const mine = await startRun(tenantA);

    expect(await store.find(tenantB, mine.id)).toBeNull();
    expect(await store.steps(tenantB, mine.id)).toEqual([]);
    expect(await store.list(tenantB)).toEqual([]);
    await expect(store.setStatus(tenantB, mine.id, 'completed')).rejects.toThrow(/not found/);
  });

  it('refuses a step pointing at another tenant’s conversation', async () => {
    const mine = await startRun(tenantA);
    const theirs = await createSession(pool, tenantB);

    // The composite foreign key, doing the job a plain one could not.
    await expect(
      store.recordStep({
        tenantId: tenantA,
        runId: mine.id,
        stepId: 'research',
        agentId: 'researcher',
        prompt: 'x',
        status: 'running',
        sessionId: theirs,
      }),
    ).rejects.toThrow();
  });

  it('erases every run with the tenant', async () => {
    const run = await startRun(tenantA);
    await store.recordStep({
      tenantId: tenantA,
      runId: run.id,
      stepId: 'research',
      agentId: 'researcher',
      prompt: 'x',
      status: 'completed',
      output: 'done',
    });

    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantA]);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM workflow_run_steps WHERE tenant_id = $1',
      [tenantA],
    );
    expect(Number(rows[0]?.count)).toBe(0);
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
    'INSERT INTO sessions (tenant_id, persona_id) VALUES ($1, $2) RETURNING id',
    [tenantId, 'test'],
  );
  return rows[0]!.id;
}
