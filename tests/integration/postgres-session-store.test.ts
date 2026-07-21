// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The Postgres session store against a real database.
 *
 * Tenant isolation is claimed by the schema, so it has to be proven against
 * the schema — an in-memory double could agree with a wrong constraint.
 *
 * Skipped when DATABASE_URL is unset, so `npm test` stays runnable without
 * Docker. CI runs it with Postgres up.
 */

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresSessionStore } from '../../src/memory/postgres-session-store.js';

const DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!DATABASE_URL)('PostgresSessionStore', () => {
  let pool: pg.Pool;
  let store: PostgresSessionStore;
  let tenantA: string;
  let tenantB: string;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    store = new PostgresSessionStore(pool);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['test-%']);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['test-%']);
    tenantA = await createTenant(pool, 'test-a');
    tenantB = await createTenant(pool, 'test-b');
  });

  it('round-trips a session', async () => {
    const created = await store.create({ tenantId: tenantA, personaId: 'default' });
    const found = await store.find(tenantA, created.id);

    expect(found).toEqual(created);
    expect(created.createdAt).toBeInstanceOf(Date);
  });

  it('stores content parts as structured JSON, not a string', async () => {
    const session = await store.create({ tenantId: tenantA, personaId: 'default' });
    await store.append(tenantA, session.id, [
      { role: 'user', content: [{ type: 'text', text: 'olá' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool_call', id: 'call-1', name: 'get_weather', input: { city: 'Recife' } },
        ],
      },
    ]);

    const messages = await store.messages(tenantA, session.id);

    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(messages[1]?.content[0]).toEqual({
      type: 'tool_call',
      id: 'call-1',
      name: 'get_weather',
      input: { city: 'Recife' },
    });
  });

  it('returns messages oldest first', async () => {
    const session = await store.create({ tenantId: tenantA, personaId: 'default' });
    for (const text of ['first', 'second', 'third']) {
      await store.append(tenantA, session.id, [
        { role: 'user', content: [{ type: 'text', text }] },
      ]);
    }

    const messages = await store.messages(tenantA, session.id);

    expect(messages.map((m) => (m.content[0] as { text: string }).text)).toEqual([
      'first',
      'second',
      'third',
    ]);
  });

  it('hides another tenant’s session', async () => {
    const session = await store.create({ tenantId: tenantA, personaId: 'default' });

    expect(await store.find(tenantB, session.id)).toBeNull();
  });

  it('hides another tenant’s messages', async () => {
    const session = await store.create({ tenantId: tenantA, personaId: 'default' });
    await store.append(tenantA, session.id, [
      { role: 'user', content: [{ type: 'text', text: 'secret' }] },
    ]);

    expect(await store.messages(tenantB, session.id)).toEqual([]);
  });

  it('refuses at the database level to attach a message to another tenant’s session', async () => {
    const session = await store.create({ tenantId: tenantA, personaId: 'default' });

    // Bypasses the store entirely: this is the constraint being tested, not
    // the application code above it.
    await expect(
      pool.query(
        `INSERT INTO messages (session_id, tenant_id, role, content)
         VALUES ($1, $2, 'user', '[]'::jsonb)`,
        [session.id, tenantB],
      ),
    ).rejects.toThrow(/messages_session_fkey/);
  });

  it('deletes a tenant’s sessions and messages along with the tenant', async () => {
    const session = await store.create({ tenantId: tenantA, personaId: 'default' });
    await store.append(tenantA, session.id, [
      { role: 'user', content: [{ type: 'text', text: 'olá' }] },
    ]);

    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantA]);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM messages WHERE session_id = $1',
      [session.id],
    );
    expect(rows[0]?.count).toBe('0');
  });

  it('rolls back the whole append when one message is invalid', async () => {
    const session = await store.create({ tenantId: tenantA, personaId: 'default' });

    await expect(
      store.append(tenantA, session.id, [
        { role: 'user', content: [{ type: 'text', text: 'kept?' }] },
        // 'system' violates messages_role_check.
        { role: 'system' as 'user', content: [{ type: 'text', text: 'invalid' }] },
      ]),
    ).rejects.toThrow(/messages_role_check/);

    expect(await store.messages(tenantA, session.id)).toEqual([]);
  });
});

async function createTenant(pool: pg.Pool, slug: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
    [slug, slug],
  );
  return rows[0]!.id;
}
