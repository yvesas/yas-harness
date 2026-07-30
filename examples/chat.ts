// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A terminal chat against a real harness — the smallest thing that proves the
 * whole chassis works.
 *
 * Every test in this repository builds `Agent`, `RoutedGateway` and the stores
 * by hand, with stubs. That is deliberate (the core must be testable without a
 * network), but it means the one function every product calls first —
 * `createHarness` — had never actually run, and no turn had ever reached a real
 * model, a real database and a real tool at once. This example is that run.
 *
 * What it exercises, in one turn: config loading, persona, the composition
 * root, the routed gateway against a live provider, the session store, the tool
 * loop, the approval pause and resume, a module's pool, the trace, and cost
 * accounting.
 *
 *     npm run chat
 *
 * Needs `DATABASE_URL` and a provider key (`ANTHROPIC_API_KEY` and/or
 * `GROQ_API_KEY`) for whichever models `config/models.json` routes to.
 *
 * ---
 *
 * **Boundary holes this example had to punch** (recorded for F7.2 — each one is
 * a gap in the harness, not a quirk of the example):
 *
 * 1. **No tenant surface.** Nothing in `src/` knows about tenants, so creating
 *    the one every other call needs means raw SQL. A product's very first
 *    action has no API.
 * 2. **No read side for traces or cost.** `createHarness` hands out the write
 *    ports; reading a trace back or asking what a session spent needs a
 *    `pg.Pool` of your own and the Postgres adapters directly.
 * 3. **No pool handle.** The harness opens a connection pool and keeps it, so
 *    an example that needs 1 or 2 opens a second one.
 *
 * Domain note: `examples/` may name a domain ("note"); `src/` may not. The
 * golden rule is about the harness, and this is a consumer of it.
 */

import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';

import pg from 'pg';
import { z } from 'zod';

import {
  PostgresTraceRecorder,
  PostgresUsageRecorder,
  ToolRegistry,
  createHarness,
  ok,
  type AgentReply,
  type Harness,
  type TraceStep,
} from '../src/index.js';

const TENANT_SLUG = 'cli-example';
const DEMO_MODULE = 'cli-demo';

async function main(): Promise<void> {
  const databaseUrl = process.env['DATABASE_URL'];
  if (!databaseUrl) {
    exit('DATABASE_URL is not set. Copy .env.example to .env and run `docker compose up -d`.');
  }

  // Hole 1 and 2: a pool of our own, for the tenant and for reading back.
  const pool = new pg.Pool({ connectionString: databaseUrl });
  const traceReader = new PostgresTraceRecorder(pool);
  const usageReader = new PostgresUsageRecorder(pool);

  const tenantId = await ensureTenant(pool);
  const tools = demoTools();

  // Hole 4: there is no way to ask the harness "am I configured?" — the only
  // way to find out is to build it and catch. Fine for a library; a setup
  // screen would want to report this rather than throw.
  let harness: Harness;
  try {
    harness = await createHarness({ tools });
  } catch (error) {
    await pool.end();
    exit(
      `could not start the harness: ${describe(error)}\n\n` +
        `  config/models.json routes to providers whose keys must be in .env:\n` +
        `    ANTHROPIC_API_KEY   for anthropic/*\n` +
        `    GROQ_API_KEY        for groq/*\n\n` +
        `  Set the ones your routes use, or edit config/models.json to route\n` +
        `  only to a provider you have a key for.`,
    );
  }
  // The tools were built before the stores existed; hand them the pool now.
  poolStore = harness.pools;
  const session = await harness.sessions.create({ tenantId, personaId: 'default' });

  console.log(`\n  yas-harness — terminal chat`);
  console.log(`  tenant ${tenantId}`);
  console.log(`  session ${session.id}`);
  console.log(
    `  tools: ${tools
      .schemas()
      .map((tool) => tool.name)
      .join(', ')}`,
  );
  console.log(`\n  Type a message. Ctrl-D to quit.\n`);

  const rl = createInterface({ input: stdin, output: stdout });

  try {
    for (;;) {
      const input = (await rl.question('you › ')).trim();
      if (input === '') {
        continue;
      }

      let reply: AgentReply;
      try {
        reply = await harness.agent.run({ tenantId, sessionId: session.id, input });
      } catch (error) {
        console.error(`\n  ✗ the turn failed: ${describe(error)}\n`);
        continue;
      }

      // The approval pause is a real stop, not an error: the turn ran nothing
      // and is waiting on a human. Resuming is a separate call.
      while (reply.stopReason === 'awaiting_approval') {
        reply = await settleApprovals(harness, rl, tenantId, session.id, reply);
      }

      console.log(`\nagent › ${reply.text || '(no answer)'}\n`);
      await report(traceReader, usageReader, tenantId, session.id, reply);
    }
  } finally {
    rl.close();
    await harness.close();
    await pool.end();
  }
}

/** Ask about each pending call, record the decision, and continue the turn. */
async function settleApprovals(
  harness: Harness,
  rl: ReturnType<typeof createInterface>,
  tenantId: string,
  sessionId: string,
  reply: AgentReply,
): Promise<AgentReply> {
  for (const approval of reply.pendingApprovals ?? []) {
    console.log(`\n  ⏸  "${approval.toolName}" needs approval`);
    console.log(`     input: ${JSON.stringify(approval.input)}`);
    const answer = (await rl.question('     approve? [y/N] ')).trim().toLowerCase();

    if (answer === 'y' || answer === 'yes') {
      await harness.approvals.approve(tenantId, approval.id, { decidedBy: 'cli' });
      console.log('     ✓ approved');
    } else {
      await harness.approvals.reject(tenantId, approval.id, {
        decidedBy: 'cli',
        reason: 'declined at the terminal',
      });
      console.log('     ✗ rejected');
    }
  }

  return harness.agent.resume({ tenantId, sessionId });
}

/** What the turn did and what it cost — the point of running this at all. */
async function report(
  traces: PostgresTraceRecorder,
  usage: PostgresUsageRecorder,
  tenantId: string,
  sessionId: string,
  reply: AgentReply,
): Promise<void> {
  const steps = await traces.trace(tenantId, reply.traceId);
  console.log('  trace');
  for (const step of steps) {
    console.log(`    ${String(step.sequence).padStart(2)} ${line(step)}`);
  }

  const spend = await usage.spend(tenantId, sessionId);
  console.log(
    `  cost  $${spend.totalCostUsd.toFixed(6)} over ${spend.calls} call(s)` +
      ` · ${spend.inputTokens} in / ${spend.outputTokens} out` +
      ` · stop: ${reply.stopReason}\n`,
  );
}

function line(step: TraceStep): string {
  const mark = step.succeeded ? '·' : '✗';
  const label = step.label ? ` ${step.label}` : '';
  const took = step.durationMs === undefined ? '' : ` (${step.durationMs}ms)`;
  const why = step.errorMessage ? ` — ${step.errorMessage}` : '';
  return `${mark} ${step.kind}${label}${took}${why}`;
}

/**
 * Three tools, chosen to cover three different paths: one plain, one gated by
 * approval, and one that reads back what the gated one wrote.
 */
function demoTools(): ToolRegistry {
  return new ToolRegistry()
    .register({
      name: 'current_time',
      description: 'The current date and time, in ISO 8601.',
      input: z.object({}),
      execute: () => Promise.resolve(ok(new Date().toISOString())),
    })
    .register({
      name: 'save_note',
      description: 'Save a short note so it can be recalled later.',
      input: z.object({ text: z.string().min(1) }),
      // The whole point of the approval queue: nothing is written until a
      // human says so.
      requiresApproval: true,
      execute: async (input, context) => {
        const key = `note:${Date.now()}`;
        await pools().set({ tenantId: context.tenantId, moduleId: DEMO_MODULE }, key, input.text);
        return ok(`saved as ${key}`);
      },
    })
    .register({
      name: 'list_notes',
      description: 'List the notes saved so far.',
      input: z.object({}),
      execute: async (_input, context) => {
        const entries = await pools().list(
          { tenantId: context.tenantId, moduleId: DEMO_MODULE },
          'note:',
        );
        return ok(
          entries.length === 0
            ? 'no notes yet'
            : entries.map((entry) => `- ${String(entry.value)}`).join('\n'),
        );
      },
    });
}

/**
 * The pool store, resolved late.
 *
 * Tools are registered before `createHarness` builds the stores, so they cannot
 * capture one at definition time. A product with its own composition would pass
 * the store into its module; here the example holds it in one place.
 */
let poolStore: Harness['pools'] | undefined;
function pools(): Harness['pools'] {
  if (!poolStore) {
    throw new Error('pool store not ready');
  }
  return poolStore;
}

/**
 * Hole 1: there is no tenant port, so the example writes the row itself.
 * `ON CONFLICT` keeps repeated runs on the same tenant, so notes survive.
 */
async function ensureTenant(pool: pg.Pool): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO tenants (slug, name) VALUES ($1, $2)
       ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
     RETURNING id`,
    [TENANT_SLUG, 'CLI example'],
  );
  return rows[0]!.id;
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function exit(message: string): never {
  console.error(`\n  ${message}\n`);
  process.exit(1);
}

await main();
