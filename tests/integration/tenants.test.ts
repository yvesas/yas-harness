// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Tenants against a real database.
 *
 * Two things matter here and neither is CRUD. The slug rule is enforced twice —
 * by the store and by the table — so a row written by anything else still
 * cannot break it. And `delete` is the erasure mechanism: every user-data table
 * cascades from this one, so a deletion request is one call, and the test that
 * proves it has to look at the other tables.
 */

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { PostgresTenantStore } from '../../src/tenants/postgres-tenant-store.js';
import { TenantError } from '../../src/tenants/tenant-store.js';

const DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!DATABASE_URL)('PostgresTenantStore', () => {
  let pool: pg.Pool;
  let store: PostgresTenantStore;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    store = new PostgresTenantStore(pool);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['tn-%']);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['tn-%']);
  });

  it('creates a tenant and finds it by id and by slug', async () => {
    const created = await store.create({ slug: 'tn-acme', name: 'Acme' });

    expect(created).toMatchObject({ slug: 'tn-acme', name: 'Acme' });
    expect(await store.find(created.id)).toMatchObject({ id: created.id });
    expect(await store.findBySlug('tn-acme')).toMatchObject({ id: created.id });
    expect(await store.findBySlug('tn-nobody')).toBeNull();
  });

  it('refuses a second tenant on the same slug', async () => {
    await store.create({ slug: 'tn-acme', name: 'Acme' });

    await expect(store.create({ slug: 'tn-acme', name: 'Other' })).rejects.toThrow();
  });

  it('ensures the same tenant twice instead of failing', async () => {
    const first = await store.ensure({ slug: 'tn-acme', name: 'Acme' });
    const second = await store.ensure({ slug: 'tn-acme', name: 'Acme Renamed' });

    // The first call of any deployment runs on every boot; it must be idempotent.
    expect(second.id).toBe(first.id);
    expect(second.name).toBe('Acme Renamed');
  });

  it('rejects a malformed slug before it reaches the table', async () => {
    // A typed error naming the rule, rather than a constraint violation.
    await expect(store.create({ slug: 'Not A Slug', name: 'x' })).rejects.toThrow(TenantError);
  });

  it('erases everything belonging to the tenant, and nothing else', async () => {
    const doomed = await store.create({ slug: 'tn-doomed', name: 'Doomed' });
    const kept = await store.create({ slug: 'tn-kept', name: 'Kept' });
    for (const id of [doomed.id, kept.id]) {
      await pool.query("INSERT INTO sessions (tenant_id, persona_id) VALUES ($1, 'default')", [id]);
      await pool.query(
        `INSERT INTO traces (tenant_id, trace_id, sequence, kind, succeeded)
         VALUES ($1, gen_random_uuid(), 0, 'input', true)`,
        [id],
      );
    }

    expect(await store.delete(doomed.id)).toBe(true);

    // One call, and the conversations and traces went with it — this is what
    // makes a deletion request answerable rather than merely promised.
    const left = await pool.query<{ sessions: string; traces: string }>(
      `SELECT (SELECT count(*) FROM sessions WHERE tenant_id = $1)::text AS sessions,
              (SELECT count(*) FROM traces   WHERE tenant_id = $1)::text AS traces`,
      [doomed.id],
    );
    expect(left.rows[0]).toEqual({ sessions: '0', traces: '0' });

    const survivor = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM sessions WHERE tenant_id = $1',
      [kept.id],
    );
    expect(survivor.rows[0]?.count).toBe('1');
  });

  it('reports nothing to erase when the tenant is already gone', async () => {
    expect(await store.delete('11111111-1111-4111-8111-111111111111')).toBe(false);
  });

  it('lists tenants', async () => {
    await store.create({ slug: 'tn-a', name: 'A' });
    await store.create({ slug: 'tn-b', name: 'B' });

    const slugs = (await store.list())
      .map((tenant) => tenant.slug)
      .filter((s) => s.startsWith('tn-'));
    expect(slugs).toEqual(['tn-a', 'tn-b']);
  });
});
