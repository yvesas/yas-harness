// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Port: a cache of connected resources.
 *
 * A connection's resources are snapshots kept locally, so the agent can browse
 * and read them without a round-trip to the source every time — and still see
 * them when the source is unreachable. The store keeps snapshots; it does not
 * decide when they are fresh or when to refresh them. That policy lives in the
 * cache-aware layer above (`CachedConnections`).
 *
 * Nothing product-domain here: a snapshot is a `Resource`, the same in a
 * language tutor and a CRM. Every method is scoped by tenant and connection —
 * no read or change spans either boundary.
 */

import type { Resource } from './connector.js';

/** Identifies one connection's slice of one tenant's cache. */
export interface CacheScope {
  readonly tenantId: string;
  readonly connectionId: string;
}

/** A cached resource and when it was fetched, for freshness decisions above. */
export interface CachedResource {
  readonly resource: Resource;
  readonly fetchedAt: Date;
}

export interface CacheListOptions {
  /**
   * Narrow to a container. Omit for every resource cached under the connection;
   * pass a string for that parent's children; pass `null` for the top level
   * (resources whose `parentId` is null).
   */
  readonly parentId?: string | null;
}

/**
 * Every method is scoped by both tenant and connection. Snapshots are stored as
 * given; the store adds only the fetch time.
 */
export interface ResourceCacheStore {
  get(scope: CacheScope, resourceId: string): Promise<CachedResource | null>;
  /** Upsert one snapshot, stamping it with the current time. */
  put(scope: CacheScope, resource: Resource): Promise<CachedResource>;
  /** Upsert many snapshots in one shot, all stamped with the same time. */
  putMany(scope: CacheScope, resources: readonly Resource[]): Promise<void>;
  delete(scope: CacheScope, resourceId: string): Promise<boolean>;
  list(scope: CacheScope, options?: CacheListOptions): Promise<CachedResource[]>;
  /**
   * Remove cached snapshots — within a parent if `options.parentId` is given,
   * else across the whole connection — whose id is not in `keep`. This is how a
   * refresh drops resources that disappeared upstream. Returns how many went.
   */
  prune(scope: CacheScope, keep: ReadonlySet<string>, options?: CacheListOptions): Promise<number>;
}

export class ResourceCacheError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ResourceCacheError';
  }
}
