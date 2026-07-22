// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Module pools against a real database.
 *
 * Isolation by (tenant_id, module_id) is a property of the primary key, so it
 * is proven against the schema — the in-memory double could agree with a wrong
 * table shape.
 */

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresPoolStore } from '../../src/pools/postgres-pool-store.js';

const DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!DATABASE_URL)('PostgresPoolStore', () => {
  let pool: pg.Pool;
  let store: PostgresPoolStore;
  let tenantA: string;
  let tenantB: string;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    store = new PostgresPoolStore(pool);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['pool-%']);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['pool-%']);
    tenantA = await createTenant(pool, 'pool-a');
    tenantB = await createTenant(pool, 'pool-b');
  });

  it('round-trips a JSON value', async () => {
    const scope = { tenantId: tenantA, moduleId: 'finance' };
    await store.set(scope, 'budget', { limit: 1000, currency: 'BRL' });

    const entry = await store.get(scope, 'budget');

    expect(entry?.value).toEqual({ limit: 1000, currency: 'BRL' });
    expect(entry?.updatedAt).toBeInstanceOf(Date);
  });

  it('upserts on conflict rather than erroring', async () => {
    const scope = { tenantId: tenantA, moduleId: 'finance' };
    await store.set(scope, 'k', 1);
    await store.set(scope, 'k', 2);

    expect((await store.get(scope, 'k'))?.value).toBe(2);
  });

  it('isolates one module from another in the same tenant', async () => {
    await store.set({ tenantId: tenantA, moduleId: 'finance' }, 'k', 'finance');

    expect(await store.get({ tenantId: tenantA, moduleId: 'calendar' }, 'k')).toBeNull();
  });

  it('isolates one tenant from another using the same module', async () => {
    await store.set({ tenantId: tenantA, moduleId: 'finance' }, 'k', 'a');

    expect(await store.get({ tenantId: tenantB, moduleId: 'finance' }, 'k')).toBeNull();
  });

  it('lists only the scope’s own entries', async () => {
    await store.set({ tenantId: tenantA, moduleId: 'finance' }, 'a', 1);
    await store.set({ tenantId: tenantA, moduleId: 'finance' }, 'b', 2);
    await store.set({ tenantId: tenantA, moduleId: 'calendar' }, 'c', 3);
    await store.set({ tenantId: tenantB, moduleId: 'finance' }, 'd', 4);

    const entries = await store.list({ tenantId: tenantA, moduleId: 'finance' });

    expect(entries.map((entry) => entry.key)).toEqual(['a', 'b']);
  });

  it('narrows a list to a key prefix', async () => {
    const scope = { tenantId: tenantA, moduleId: 'finance' };
    await store.set(scope, 'expense:1', 1);
    await store.set(scope, 'expense:2', 2);
    await store.set(scope, 'budget', 3);

    const entries = await store.list(scope, 'expense:');

    expect(entries.map((entry) => entry.key)).toEqual(['expense:1', 'expense:2']);
  });

  it('reports whether a delete removed anything', async () => {
    const scope = { tenantId: tenantA, moduleId: 'finance' };
    await store.set(scope, 'k', 1);

    expect(await store.delete(scope, 'k')).toBe(true);
    expect(await store.delete(scope, 'k')).toBe(false);
  });

  it('rejects an id the schema’s format check forbids', async () => {
    await expect(store.set({ tenantId: tenantA, moduleId: 'Bad Module' }, 'k', 1)).rejects.toThrow(
      /module_pools_module_id_format/,
    );
  });

  it('deletes a tenant’s pool data along with the tenant', async () => {
    await store.set({ tenantId: tenantA, moduleId: 'finance' }, 'k', 1);

    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantA]);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM module_pools WHERE tenant_id = $1',
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
