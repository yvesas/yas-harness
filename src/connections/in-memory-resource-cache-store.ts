// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: the resource cache in process memory.
 *
 * For tests and for running without a database. It scopes by tenant and
 * connection exactly like the Postgres adapter — a looser double would let an
 * isolation bug pass the suite. The clock is injectable so freshness is
 * deterministic in tests.
 */

import type { Resource } from './connector.js';
import type {
  CacheListOptions,
  CacheScope,
  CachedResource,
  ResourceCacheStore,
} from './resource-cache-store.js';

interface Stored {
  scopeKey: string;
  resourceId: string;
  parentId: string | null;
  entry: CachedResource;
}

// The methods are async on purpose: they do no I/O, but being async keeps the
// same shape as the Postgres adapter (a rejection is a rejected promise).
/* eslint-disable @typescript-eslint/require-await */

export class InMemoryResourceCacheStore implements ResourceCacheStore {
  readonly #rows = new Map<string, Stored>();
  readonly #now: () => Date;

  constructor(options: { now?: () => Date } = {}) {
    this.#now = options.now ?? (() => new Date());
  }

  async get(scope: CacheScope, resourceId: string): Promise<CachedResource | null> {
    return this.#rows.get(this.#id(scope, resourceId))?.entry ?? null;
  }

  async put(scope: CacheScope, resource: Resource): Promise<CachedResource> {
    const entry: CachedResource = { resource: structuredClone(resource), fetchedAt: this.#now() };
    this.#rows.set(this.#id(scope, resource.id), {
      scopeKey: this.#scopeKey(scope),
      resourceId: resource.id,
      parentId: resource.parentId,
      entry,
    });
    return entry;
  }

  async putMany(scope: CacheScope, resources: readonly Resource[]): Promise<void> {
    const fetchedAt = this.#now();
    for (const resource of resources) {
      this.#rows.set(this.#id(scope, resource.id), {
        scopeKey: this.#scopeKey(scope),
        resourceId: resource.id,
        parentId: resource.parentId,
        entry: { resource: structuredClone(resource), fetchedAt },
      });
    }
  }

  async delete(scope: CacheScope, resourceId: string): Promise<boolean> {
    return this.#rows.delete(this.#id(scope, resourceId));
  }

  async list(scope: CacheScope, options: CacheListOptions = {}): Promise<CachedResource[]> {
    return this.#within(scope, options)
      .map((row) => row.entry)
      .sort((a, b) => a.resource.id.localeCompare(b.resource.id));
  }

  async prune(
    scope: CacheScope,
    keep: ReadonlySet<string>,
    options: CacheListOptions = {},
  ): Promise<number> {
    let pruned = 0;
    for (const row of this.#within(scope, options)) {
      if (!keep.has(row.resourceId)) {
        this.#rows.delete(this.#id(scope, row.resourceId));
        pruned += 1;
      }
    }
    return pruned;
  }

  /** Rows under a scope, filtered by the parent rule in `options`. */
  #within(scope: CacheScope, options: CacheListOptions): Stored[] {
    const scopeKey = this.#scopeKey(scope);
    const filterByParent = 'parentId' in options;
    return [...this.#rows.values()].filter(
      (row) =>
        row.scopeKey === scopeKey &&
        (!filterByParent || row.parentId === (options.parentId ?? null)),
    );
  }

  #scopeKey(scope: CacheScope): string {
    // Length-prefixed so no combination of ids can collide with another scope.
    return `${scope.tenantId.length}:${scope.tenantId}/${scope.connectionId.length}:${scope.connectionId}`;
  }

  #id(scope: CacheScope, resourceId: string): string {
    return `${this.#scopeKey(scope)}/${resourceId}`;
  }
}
