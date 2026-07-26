// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Cache-aware connections: the policy over the resource cache.
 *
 * It wraps the connection operations with a local snapshot store so a read is
 * served from cache while fresh, browsing works offline, and a source outage
 * degrades to the last known snapshot instead of an error. Writes update the
 * cache so it never lags an edit the agent just made.
 *
 * Keeping the cache warm is a mechanic, not a background job — the harness is a
 * library, so it exposes `refresh` (poll on the product's own schedule) and
 * `invalidate` (call from the product's own webhook endpoint), the same
 * boundary OAuth draws for the callback. Nothing here is product domain: it
 * caches `Resource`s, which mean the same in a language tutor and a CRM.
 */

import type {
  ListOptions,
  Resource,
  ResourceDraft,
  ResourcePage,
  ResourcePatch,
  SearchOptions,
} from './connector.js';
import type { CacheScope, CachedResource, ResourceCacheStore } from './resource-cache-store.js';

/**
 * The connection operations the cache sits in front of. `ConnectionManager`
 * satisfies this structurally; depending on the shape, not the class, keeps the
 * cache a policy layer that a test can drive with a light double.
 */
export interface ConnectionOperations {
  read(tenantId: string, connectionId: string, id: string): Promise<Resource>;
  list(tenantId: string, connectionId: string, options?: ListOptions): Promise<ResourcePage>;
  search(
    tenantId: string,
    connectionId: string,
    query: string,
    options?: SearchOptions,
  ): Promise<ResourcePage>;
  create(tenantId: string, connectionId: string, draft: ResourceDraft): Promise<Resource>;
  update(
    tenantId: string,
    connectionId: string,
    id: string,
    patch: ResourcePatch,
  ): Promise<Resource>;
  delete(tenantId: string, connectionId: string, id: string): Promise<void>;
}

export interface CachedConnectionsOptions {
  /** How long a read-through snapshot stays fresh. Default 5 minutes. */
  readonly ttlMs?: number;
  /** How many list pages a refresh will page through. Default 50. */
  readonly maxRefreshPages?: number;
  readonly now?: () => Date;
}

/** What one refresh did, so a caller can log or alert on it. */
export interface RefreshSummary {
  readonly fetched: number;
  readonly pruned: number;
  /** True if the page cap was hit — not all resources were seen, so nothing was pruned. */
  readonly truncated: boolean;
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;
const DEFAULT_MAX_REFRESH_PAGES = 50;

export class CachedConnections {
  readonly #source: ConnectionOperations;
  readonly #cache: ResourceCacheStore;
  readonly #ttlMs: number;
  readonly #maxRefreshPages: number;
  readonly #now: () => Date;

  constructor(
    source: ConnectionOperations,
    cache: ResourceCacheStore,
    options: CachedConnectionsOptions = {},
  ) {
    this.#source = source;
    this.#cache = cache;
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#maxRefreshPages = options.maxRefreshPages ?? DEFAULT_MAX_REFRESH_PAGES;
    this.#now = options.now ?? (() => new Date());
  }

  // --- reads (cache-aware) --------------------------------------------------

  /**
   * Read through the cache: a fresh snapshot is served as-is; otherwise the
   * source is asked and the result cached. If the source fails and a snapshot
   * exists, the stale snapshot is served rather than surfacing the error — the
   * cache's reason to exist is to survive the source being down.
   */
  async read(tenantId: string, connectionId: string, id: string): Promise<Resource> {
    const scope = { tenantId, connectionId };
    const cached = await this.#cache.get(scope, id);
    if (cached && this.#isFresh(cached)) {
      return cached.resource;
    }
    try {
      const fresh = await this.#source.read(tenantId, connectionId, id);
      await this.#cache.put(scope, fresh);
      return fresh;
    } catch (error) {
      if (cached) {
        return cached.resource;
      }
      throw error;
    }
  }

  /** List live, warming the cache with the page as a side effect. */
  async list(tenantId: string, connectionId: string, options?: ListOptions): Promise<ResourcePage> {
    const page = await this.#source.list(tenantId, connectionId, options);
    await this.#cache.putMany({ tenantId, connectionId }, page.resources);
    return page;
  }

  /** Search live, warming the cache with the results as a side effect. */
  async search(
    tenantId: string,
    connectionId: string,
    query: string,
    options?: SearchOptions,
  ): Promise<ResourcePage> {
    const page = await this.#source.search(tenantId, connectionId, query, options);
    await this.#cache.putMany({ tenantId, connectionId }, page.resources);
    return page;
  }

  // --- writes (write-through) -----------------------------------------------

  async create(tenantId: string, connectionId: string, draft: ResourceDraft): Promise<Resource> {
    const created = await this.#source.create(tenantId, connectionId, draft);
    await this.#cache.put({ tenantId, connectionId }, created);
    return created;
  }

  async update(
    tenantId: string,
    connectionId: string,
    id: string,
    patch: ResourcePatch,
  ): Promise<Resource> {
    const updated = await this.#source.update(tenantId, connectionId, id, patch);
    await this.#cache.put({ tenantId, connectionId }, updated);
    return updated;
  }

  async delete(tenantId: string, connectionId: string, id: string): Promise<void> {
    await this.#source.delete(tenantId, connectionId, id);
    await this.#cache.delete({ tenantId, connectionId }, id);
  }

  // --- cached-only access (offline browse) ----------------------------------

  /** The cached snapshot for a resource, or null — never touches the source. */
  async getCached(
    tenantId: string,
    connectionId: string,
    id: string,
  ): Promise<CachedResource | null> {
    return this.#cache.get({ tenantId, connectionId }, id);
  }

  /**
   * Browse cached resources without touching the source. Pass `parentId` to
   * narrow to a folder's children (`null` for the top level), or omit it for
   * everything cached under the connection.
   */
  async listCached(
    tenantId: string,
    connectionId: string,
    options?: { parentId?: string | null },
  ): Promise<CachedResource[]> {
    return this.#cache.list({ tenantId, connectionId }, options);
  }

  // --- keeping the cache warm (mechanics, not a scheduler) -------------------

  /**
   * Poll the source and reconcile the cache: page through the listing, upsert
   * every resource, and prune the ones that vanished upstream. Scope it to a
   * folder with `parentId`; omit it to refresh everything the listing returns.
   *
   * If the page cap is reached the listing is incomplete, so nothing is pruned
   * — pruning against a partial view would delete resources that still exist.
   */
  async refresh(
    tenantId: string,
    connectionId: string,
    options: { parentId?: string | null } = {},
  ): Promise<RefreshSummary> {
    const scope: CacheScope = { tenantId, connectionId };
    const scopedToParent = 'parentId' in options;
    const parentId = options.parentId;

    const seen = new Set<string>();
    const collected: Resource[] = [];
    let cursor: string | undefined;
    let pages = 0;
    let truncated = false;

    do {
      const listOptions: ListOptions = {
        ...(scopedToParent && typeof parentId === 'string' ? { parentId } : {}),
        ...(cursor ? { cursor } : {}),
      };
      const page = await this.#source.list(tenantId, connectionId, listOptions);
      for (const resource of page.resources) {
        seen.add(resource.id);
        collected.push(resource);
      }
      cursor = page.nextCursor ?? undefined;
      pages += 1;
      if (cursor && pages >= this.#maxRefreshPages) {
        truncated = true;
        break;
      }
    } while (cursor);

    await this.#cache.putMany(scope, collected);
    const pruned = truncated
      ? 0
      : await this.#cache.prune(scope, seen, scopedToParent ? { parentId: parentId ?? null } : {});
    return { fetched: collected.length, pruned, truncated };
  }

  /**
   * Drop a resource's snapshot so the next read re-fetches it. This is the
   * webhook mechanic: the product's endpoint receives "resource X changed" and
   * calls this; the harness owns no HTTP surface of its own.
   */
  async invalidate(tenantId: string, connectionId: string, id: string): Promise<boolean> {
    return this.#cache.delete({ tenantId, connectionId }, id);
  }

  #isFresh(cached: CachedResource): boolean {
    return this.#now().getTime() - cached.fetchedAt.getTime() < this.#ttlMs;
  }
}
