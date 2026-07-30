// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * `createHarness` — the composition root — actually running.
 *
 * Until now every test built `Agent`, `RoutedGateway` and the stores by hand.
 * That keeps the core testable without a network, but it left the one function
 * every product calls first completely unexercised: nothing had ever loaded the
 * config, wired the adapters and run a turn through the assembled whole.
 *
 * The model is scripted; everything else is real — the config on disk, Postgres,
 * the tool registry, the approval queue, the pool, the trace and the usage row.
 * What is under test is the wiring, not the agent loop (which has its own
 * tests): that the pieces are connected to each other in the order the harness
 * claims, and that the redacting decorators are in the path.
 *
 * **Not covered here, and it is a consequence worth knowing:** cost accounting
 * cannot be asserted from this seat. The usage recorder lives inside
 * `RoutedGateway`, so a supplied gateway bypasses it — a product that injects
 * its own gateway takes over its own accounting. Pricing and attribution have
 * their own tests against the routed gateway.
 */

import pg from 'pg';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ScriptedGateway, callsTool, says } from '../../src/models/scripted-gateway.js';
import { ToolRegistry, ok } from '../../src/core/tool.js';
import { PostgresTraceRecorder } from '../../src/telemetry/postgres-trace-recorder.js';
import { createHarness, type Harness } from '../../src/index.js';

const DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!DATABASE_URL)('createHarness', () => {
  let pool: pg.Pool;
  let tenantId: string;
  let harness: Harness;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['compose-%']);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['compose-%']);
    const { rows } = await pool.query<{ id: string }>(
      "INSERT INTO tenants (slug, name) VALUES ('compose-a', 'compose') RETURNING id",
    );
    tenantId = rows[0]!.id;
  });

  afterEach(async () => {
    await harness?.close();
  });

  /** A tool with a visible effect, plus a gated one to reach the pause. */
  function tools(): ToolRegistry {
    return new ToolRegistry()
      .register({
        name: 'shout',
        description: 'Upper-case a word.',
        input: z.object({ word: z.string() }),
        execute: (input) => Promise.resolve(ok(input.word.toUpperCase())),
      })
      .register({
        name: 'commit_it',
        description: 'Something that needs a human.',
        input: z.object({}),
        requiresApproval: true,
        execute: () => Promise.resolve(ok('done')),
      });
  }

  it('assembles a working harness and runs a turn through it', async () => {
    harness = await createHarness({
      gateway: new ScriptedGateway([says('Olá!')]),
      tools: tools(),
    });
    const session = await harness.sessions.create({ tenantId, personaId: 'default' });

    const reply = await harness.agent.run({ tenantId, sessionId: session.id, input: 'oi' });

    expect(reply).toMatchObject({ text: 'Olá!', stopReason: 'end_turn' });
    // The conversation was persisted through the assembled session store.
    const history = await harness.sessions.messages(tenantId, session.id);
    expect(history).toHaveLength(2);
  });

  it('wires the tool registry into the loop', async () => {
    harness = await createHarness({
      gateway: new ScriptedGateway([callsTool('shout', { word: 'oi' }), says('OI, then.')]),
      tools: tools(),
    });
    const session = await harness.sessions.create({ tenantId, personaId: 'default' });

    const reply = await harness.agent.run({ tenantId, sessionId: session.id, input: 'shout oi' });

    expect(reply.toolInvocations).toMatchObject([{ name: 'shout', output: 'OI' }]);
  });

  it('wires the approval queue, so a gated tool pauses the turn', async () => {
    harness = await createHarness({
      gateway: new ScriptedGateway([callsTool('commit_it', {}), says('Committed.')]),
      tools: tools(),
    });
    const session = await harness.sessions.create({ tenantId, personaId: 'default' });

    const paused = await harness.agent.run({ tenantId, sessionId: session.id, input: 'do it' });

    expect(paused.stopReason).toBe('awaiting_approval');
    const pending = paused.pendingApprovals ?? [];
    expect(pending).toHaveLength(1);

    // And the queue the harness assembled is the one that unblocks it.
    await harness.approvals.approve(tenantId, pending[0]!.id, { decidedBy: 'test' });
    const resumed = await harness.agent.resume({ tenantId, sessionId: session.id });

    expect(resumed).toMatchObject({ text: 'Committed.', stopReason: 'end_turn' });
  });

  it('wires the trace recorder, redacted, all the way to the table', async () => {
    harness = await createHarness({
      gateway: new ScriptedGateway([says('noted')]),
      tools: tools(),
    });
    const session = await harness.sessions.create({ tenantId, personaId: 'default' });

    const reply = await harness.agent.run({
      tenantId,
      sessionId: session.id,
      input: 'my key is postgres://user:s3cr3tpass@db',
    });

    const steps = await new PostgresTraceRecorder(pool).trace(tenantId, reply.traceId);
    expect(steps.map((step) => step.kind)).toEqual(['input', 'model_call', 'reply']);
    // Nothing in the trace should carry the secret. The input step deliberately
    // stores only a length, and the redactor guards every other free-text field.
    expect(JSON.stringify(steps)).not.toContain('s3cr3tpass');
  });

  it('exposes a pool that is namespaced per module', async () => {
    harness = await createHarness({ gateway: new ScriptedGateway([]), tools: tools() });

    await harness.pools.set({ tenantId, moduleId: 'alpha' }, 'k', 'from-alpha');

    expect(await harness.pools.get({ tenantId, moduleId: 'beta' }, 'k')).toBeNull();
    expect(await harness.pools.get({ tenantId, moduleId: 'alpha' }, 'k')).toMatchObject({
      value: 'from-alpha',
    });
  });
});
