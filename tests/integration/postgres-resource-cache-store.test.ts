// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The resource cache against a real database. The guarantees proven here are
 * structural: a snapshot round-trips (dates and all), the parent filter and
 * prune work in SQL, a snapshot cannot cross into another tenant, and the cache
 * is removed with its connection by the composite foreign key's cascade.
 */

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import type { Connection } from '../../src/connections/connection-store.js';
import type { Resource } from '../../src/connections/connector.js';
import { PostgresConnectionStore } from '../../src/connections/postgres-connection-store.js';
import { PostgresResourceCacheStore } from '../../src/connections/postgres-resource-cache-store.js';

const DATABASE_URL = process.env['DATABASE_URL'];

function res(id: string, parentId: string | null = null, extra: Partial<Resource> = {}): Resource {
  return {
    id,
    type: 'file',
    title: id,
    content: null,
    mimeType: null,
    parentId,
    url: null,
    metadata: {},
    createdAt: null,
    updatedAt: null,
    ...extra,
  };
}

describe.skipIf(!DATABASE_URL)('resource cache (Postgres)', () => {
  let pool: pg.Pool;
  let store: PostgresResourceCacheStore;
  let connections: PostgresConnectionStore;
  let tenantA: string;
  let tenantB: string;
  let connA: Connection;
  let connB: Connection;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    store = new PostgresResourceCacheStore(pool);
    connections = new PostgresConnectionStore(pool);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['cache-%']);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['cache-%']);
    tenantA = await createTenant(pool, 'cache-a');
    tenantB = await createTenant(pool, 'cache-b');
    connA = await connections.create({ tenantId: tenantA, connectorId: 'google-drive' });
    connB = await connections.create({ tenantId: tenantB, connectorId: 'google-drive' });
  });

  function scopeA() {
    return { tenantId: tenantA, connectionId: connA.id };
  }

  it('round-trips a snapshot, reviving its dates', async () => {
    const created = new Date('2026-07-01T00:00:00.000Z');
    await store.put(scopeA(), res('f1', null, { createdAt: created, title: 'Notes' }));

    const got = await store.get(scopeA(), 'f1');

    expect(got?.resource.title).toBe('Notes');
    expect(got?.resource.createdAt).toBeInstanceOf(Date);
    expect(got?.resource.createdAt?.toISOString()).toBe(created.toISOString());
    expect(got?.fetchedAt).toBeInstanceOf(Date);
  });

  it('upserts on conflict, replacing the snapshot', async () => {
    await store.put(scopeA(), res('f1', null, { title: 'Old' }));
    await store.put(scopeA(), res('f1', null, { title: 'New' }));

    const got = await store.get(scopeA(), 'f1');
    expect(got?.resource.title).toBe('New');
  });

  it('putMany, then lists by parent and at the top level', async () => {
    await store.putMany(scopeA(), [res('top', null), res('child', 'dir'), res('child2', 'dir')]);

    const children = await store.list(scopeA(), { parentId: 'dir' });
    expect(children.map((c) => c.resource.id)).toEqual(['child', 'child2']);

    const topLevel = await store.list(scopeA(), { parentId: null });
    expect(topLevel.map((c) => c.resource.id)).toEqual(['top']);

    const all = await store.list(scopeA());
    expect(all).toHaveLength(3);
  });

  it('prunes within a parent, keeping the listed ids and other parents', async () => {
    await store.putMany(scopeA(), [res('keep', 'dir'), res('gone', 'dir'), res('other', 'x')]);

    const pruned = await store.prune(scopeA(), new Set(['keep']), { parentId: 'dir' });

    expect(pruned).toBe(1);
    expect(await store.get(scopeA(), 'gone')).toBeNull();
    expect(await store.get(scopeA(), 'keep')).not.toBeNull();
    expect(await store.get(scopeA(), 'other')).not.toBeNull();
  });

  it('keeps a tenant’s cache invisible to another tenant', async () => {
    await store.put(scopeA(), res('shared'));

    const fromB = await store.get({ tenantId: tenantB, connectionId: connB.id }, 'shared');
    expect(fromB).toBeNull();

    // Even naming tenant A's connection under tenant B resolves to nothing.
    const crossed = await store.get({ tenantId: tenantB, connectionId: connA.id }, 'shared');
    expect(crossed).toBeNull();
  });

  it('is removed with its connection (composite FK cascade)', async () => {
    await store.put(scopeA(), res('f1'));
    expect(await store.get(scopeA(), 'f1')).not.toBeNull();

    await connections.remove(tenantA, connA.id);

    const { rows } = await pool.query('SELECT 1 FROM resource_cache WHERE connection_id = $1', [
      connA.id,
    ]);
    expect(rows).toHaveLength(0);
  });
});

async function createTenant(pool: pg.Pool, slug: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
    [slug, slug],
  );
  return rows[0]!.id;
}
