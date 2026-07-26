// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The in-memory resource cache, which doubles for the Postgres adapter in tests
 * and must isolate exactly as it does: by tenant and by connection. Also covers
 * the parent filter (all / a folder / the top level), pruning, and that stored
 * snapshots are copies, not references to the caller's object.
 */

import { describe, expect, it } from 'vitest';

import type { Resource } from '../../src/connections/connector.js';
import { InMemoryResourceCacheStore } from '../../src/connections/in-memory-resource-cache-store.js';

function res(id: string, parentId: string | null = null): Resource {
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
  };
}

const scope = { tenantId: 't1', connectionId: 'c1' };

describe('InMemoryResourceCacheStore', () => {
  it('round-trips a snapshot and stamps it with the clock', async () => {
    const store = new InMemoryResourceCacheStore({ now: () => new Date(5000) });

    const put = await store.put(scope, res('a'));
    expect(put.fetchedAt).toEqual(new Date(5000));

    const got = await store.get(scope, 'a');
    expect(got?.resource.id).toBe('a');
    expect(got?.fetchedAt).toEqual(new Date(5000));
  });

  it('returns null for a miss', async () => {
    const store = new InMemoryResourceCacheStore();
    expect(await store.get(scope, 'nope')).toBeNull();
  });

  it('stores a copy, so mutating the input does not change the snapshot', async () => {
    const store = new InMemoryResourceCacheStore();
    const resource = res('a');
    await store.put(scope, resource);

    resource.metadata['leaked'] = true;

    const got = await store.get(scope, 'a');
    expect(got?.resource.metadata).toEqual({});
  });

  it('putMany stamps every snapshot with the same time', async () => {
    let t = 1000;
    const store = new InMemoryResourceCacheStore({ now: () => new Date((t += 1000)) });

    await store.putMany(scope, [res('a'), res('b')]);

    const a = await store.get(scope, 'a');
    const b = await store.get(scope, 'b');
    expect(a?.fetchedAt).toEqual(b?.fetchedAt);
  });

  it('deletes a snapshot', async () => {
    const store = new InMemoryResourceCacheStore();
    await store.put(scope, res('a'));

    expect(await store.delete(scope, 'a')).toBe(true);
    expect(await store.delete(scope, 'a')).toBe(false);
    expect(await store.get(scope, 'a')).toBeNull();
  });

  it('lists everything under the connection when no parent is given', async () => {
    const store = new InMemoryResourceCacheStore();
    await store.putMany(scope, [res('b', 'dir'), res('a', null)]);

    const all = await store.list(scope);
    expect(all.map((c) => c.resource.id)).toEqual(['a', 'b']); // sorted by id
  });

  it('lists a folder’s children, and the top level, separately', async () => {
    const store = new InMemoryResourceCacheStore();
    await store.putMany(scope, [res('top', null), res('child', 'dir')]);

    const children = await store.list(scope, { parentId: 'dir' });
    expect(children.map((c) => c.resource.id)).toEqual(['child']);

    const topLevel = await store.list(scope, { parentId: null });
    expect(topLevel.map((c) => c.resource.id)).toEqual(['top']);
  });

  it('prunes within a parent, keeping the listed ids and other parents', async () => {
    const store = new InMemoryResourceCacheStore();
    await store.putMany(scope, [res('keep', 'dir'), res('gone', 'dir'), res('other', 'elsewhere')]);

    const pruned = await store.prune(scope, new Set(['keep']), { parentId: 'dir' });

    expect(pruned).toBe(1);
    expect((await store.get(scope, 'gone')) === null).toBe(true);
    expect((await store.get(scope, 'keep'))?.resource.id).toBe('keep');
    expect((await store.get(scope, 'other'))?.resource.id).toBe('other'); // untouched
  });

  it('prunes across the whole connection when no parent is given', async () => {
    const store = new InMemoryResourceCacheStore();
    await store.putMany(scope, [res('keep', 'a'), res('gone', 'b')]);

    const pruned = await store.prune(scope, new Set(['keep']));

    expect(pruned).toBe(1);
    expect(await store.get(scope, 'gone')).toBeNull();
  });

  it('isolates by connection and by tenant — same id never collides', async () => {
    const store = new InMemoryResourceCacheStore();
    const otherConn = { tenantId: 't1', connectionId: 'c2' };
    const otherTenant = { tenantId: 't2', connectionId: 'c1' };

    await store.put(scope, res('same'));
    await store.put(otherConn, res('same'));
    await store.put(otherTenant, res('same'));

    // Deleting in one scope leaves the others intact.
    await store.delete(scope, 'same');
    expect(await store.get(scope, 'same')).toBeNull();
    expect((await store.get(otherConn, 'same'))?.resource.id).toBe('same');
    expect((await store.get(otherTenant, 'same'))?.resource.id).toBe('same');

    expect(await store.list(otherConn)).toHaveLength(1);
  });
});
