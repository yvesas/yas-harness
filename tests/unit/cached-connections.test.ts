// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The cache policy over the connection operations. Driven by a fake source and
 * a controllable clock, it proves the behaviours that matter: read-through with
 * a TTL, serving a stale snapshot when the source is down, write-through on
 * edits, refresh that pages and prunes, refresh that refuses to prune a
 * truncated view, and invalidate.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import { CachedConnections } from '../../src/connections/cached-connections.js';
import type { ConnectionOperations } from '../../src/connections/cached-connections.js';
import type {
  ListOptions,
  Resource,
  ResourceDraft,
  ResourcePage,
  ResourcePatch,
} from '../../src/connections/connector.js';
import { InMemoryResourceCacheStore } from '../../src/connections/in-memory-resource-cache-store.js';

function res(id: string, parentId: string | null = null, title = id): Resource {
  return {
    id,
    type: 'file',
    title,
    content: null,
    mimeType: null,
    parentId,
    url: null,
    metadata: {},
    createdAt: null,
    updatedAt: null,
  };
}

// The fake's methods are async to satisfy the interface but do no awaiting;
// that is the point of a double, so silence the rule here as the real
// in-memory adapters do.
/* eslint-disable @typescript-eslint/require-await */
class FakeSource implements ConnectionOperations {
  readCalls: string[] = [];
  listCalls: (ListOptions | undefined)[] = [];
  createCalls = 0;
  updateCalls = 0;
  deleteCalls: string[] = [];

  readError: Error | null = null;
  readValue: (id: string) => Resource = (id) => res(id);
  #listPages: ResourcePage[] = [];

  queueListPages(...pages: ResourcePage[]): void {
    this.#listPages = pages;
  }

  async read(_t: string, _c: string, id: string): Promise<Resource> {
    this.readCalls.push(id);
    if (this.readError) throw this.readError;
    return this.readValue(id);
  }

  async list(_t: string, _c: string, options?: ListOptions): Promise<ResourcePage> {
    this.listCalls.push(options);
    return this.#listPages.shift() ?? { resources: [], nextCursor: null };
  }

  async search(): Promise<ResourcePage> {
    return { resources: [], nextCursor: null };
  }

  async create(_t: string, _c: string, draft: ResourceDraft): Promise<Resource> {
    this.createCalls += 1;
    return res('created', draft.parentId ?? null, draft.title);
  }

  async update(_t: string, _c: string, id: string, patch: ResourcePatch): Promise<Resource> {
    this.updateCalls += 1;
    return res(id, null, patch.title ?? 'updated');
  }

  async delete(_t: string, _c: string, id: string): Promise<void> {
    this.deleteCalls.push(id);
  }
}

const scope = { tenantId: 't', connectionId: 'c' };

let source: FakeSource;
let cache: InMemoryResourceCacheStore;
let cached: CachedConnections;
let clockMs: number;

beforeEach(() => {
  source = new FakeSource();
  clockMs = 10_000;
  const now = (): Date => new Date(clockMs);
  cache = new InMemoryResourceCacheStore({ now });
  cached = new CachedConnections(source, cache, { ttlMs: 1000, now });
});

describe('CachedConnections — read-through', () => {
  it('fetches on a miss, then serves from cache while fresh', async () => {
    await cached.read('t', 'c', 'a');
    await cached.read('t', 'c', 'a');

    expect(source.readCalls).toEqual(['a']); // second read hit the cache
  });

  it('refetches once the snapshot is older than the TTL', async () => {
    await cached.read('t', 'c', 'a');
    clockMs += 2000; // past the 1000ms TTL

    await cached.read('t', 'c', 'a');

    expect(source.readCalls).toEqual(['a', 'a']);
  });

  it('serves a stale snapshot when the source is down', async () => {
    await cached.read('t', 'c', 'a'); // warm the cache
    clockMs += 2000; // stale
    source.readError = new Error('source unreachable');

    const resource = await cached.read('t', 'c', 'a');

    expect(resource.id).toBe('a'); // stale, but better than an error
  });

  it('propagates the error when the source is down and nothing is cached', async () => {
    source.readError = new Error('source unreachable');

    await expect(cached.read('t', 'c', 'missing')).rejects.toThrow('source unreachable');
  });
});

describe('CachedConnections — warming and write-through', () => {
  it('warms the cache from a live list', async () => {
    source.queueListPages({ resources: [res('x'), res('y')], nextCursor: null });

    const page = await cached.list('t', 'c');

    expect(page.resources.map((r) => r.id)).toEqual(['x', 'y']);
    expect((await cached.getCached('t', 'c', 'x'))?.resource.id).toBe('x');
  });

  it('caches a created resource', async () => {
    const created = await cached.create('t', 'c', { title: 'New' });

    expect((await cached.getCached('t', 'c', created.id))?.resource.title).toBe('New');
  });

  it('caches an updated resource', async () => {
    const updated = await cached.update('t', 'c', 'a', { title: 'Renamed' });

    expect(updated.title).toBe('Renamed');
    expect((await cached.getCached('t', 'c', 'a'))?.resource.title).toBe('Renamed');
  });

  it('drops a deleted resource from the cache', async () => {
    await cache.put(scope, res('a'));

    await cached.delete('t', 'c', 'a');

    expect(await cached.getCached('t', 'c', 'a')).toBeNull();
    expect(source.deleteCalls).toEqual(['a']);
  });
});

describe('CachedConnections — refresh (polling)', () => {
  it('pages through the listing, upserts all, and prunes what vanished', async () => {
    await cache.put(scope, res('old')); // present locally, gone upstream
    source.queueListPages(
      { resources: [res('a'), res('b')], nextCursor: 'CURSOR1' },
      { resources: [res('c')], nextCursor: null },
    );

    const summary = await cached.refresh('t', 'c');

    expect(summary).toEqual({ fetched: 3, pruned: 1, truncated: false });
    expect((await cached.listCached('t', 'c')).map((c) => c.resource.id)).toEqual(['a', 'b', 'c']);
    expect(source.listCalls[1]?.cursor).toBe('CURSOR1'); // threaded the cursor
  });

  it('does not prune when the listing is truncated at the page cap', async () => {
    const capped = new CachedConnections(source, cache, {
      maxRefreshPages: 1,
      now: () => new Date(clockMs),
    });
    await cache.put(scope, res('old'));
    source.queueListPages({ resources: [res('a')], nextCursor: 'MORE' });

    const summary = await capped.refresh('t', 'c');

    expect(summary).toEqual({ fetched: 1, pruned: 0, truncated: true });
    expect(await capped.getCached('t', 'c', 'old')).not.toBeNull(); // survived
  });

  it('refresh scoped to a parent prunes only within that parent', async () => {
    await cache.putMany(scope, [res('gone', 'dir'), res('other', 'elsewhere')]);
    source.queueListPages({ resources: [res('kept', 'dir')], nextCursor: null });

    const summary = await cached.refresh('t', 'c', { parentId: 'dir' });

    expect(summary.pruned).toBe(1); // 'gone' removed
    expect(source.listCalls[0]?.parentId).toBe('dir');
    expect(await cached.getCached('t', 'c', 'other')).not.toBeNull(); // other parent untouched
    expect(await cached.getCached('t', 'c', 'kept')).not.toBeNull();
  });
});

describe('CachedConnections — invalidate (webhook)', () => {
  it('drops a snapshot so the next read refetches it', async () => {
    await cached.read('t', 'c', 'a'); // cached
    expect(await cached.invalidate('t', 'c', 'a')).toBe(true);

    await cached.read('t', 'c', 'a'); // must go back to the source

    expect(source.readCalls).toEqual(['a', 'a']);
  });
});
