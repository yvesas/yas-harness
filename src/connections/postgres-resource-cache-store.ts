// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: the resource cache in PostgreSQL.
 *
 * The primary key is (tenant_id, connection_id, resource_id), so isolation is
 * structural: a query for one connection's cache cannot return another's, and
 * no code path forgets to scope by both. `parent_id` is copied out of the
 * snapshot so a folder's cached children can be listed without unpacking JSON.
 */

import type { Pool } from 'pg';

import type { Resource } from './connector.js';
import type {
  CacheListOptions,
  CacheScope,
  CachedResource,
  ResourceCacheStore,
} from './resource-cache-store.js';

interface CacheRow {
  resource: Resource;
  fetched_at: Date;
}

export class PostgresResourceCacheStore implements ResourceCacheStore {
  constructor(private readonly pool: Pool) {}

  async get(scope: CacheScope, resourceId: string): Promise<CachedResource | null> {
    const { rows } = await this.pool.query<CacheRow>(
      `SELECT resource, fetched_at
         FROM resource_cache
        WHERE tenant_id = $1 AND connection_id = $2 AND resource_id = $3`,
      [scope.tenantId, scope.connectionId, resourceId],
    );
    const row = rows[0];
    return row ? toCached(row) : null;
  }

  async put(scope: CacheScope, resource: Resource): Promise<CachedResource> {
    const { rows } = await this.pool.query<CacheRow>(
      `INSERT INTO resource_cache (tenant_id, connection_id, resource_id, parent_id, resource)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, connection_id, resource_id)
       DO UPDATE SET parent_id = excluded.parent_id,
                     resource  = excluded.resource,
                     fetched_at = now()
       RETURNING resource, fetched_at`,
      [
        scope.tenantId,
        scope.connectionId,
        resource.id,
        resource.parentId,
        JSON.stringify(resource),
      ],
    );
    return toCached(rows[0]!);
  }

  async putMany(scope: CacheScope, resources: readonly Resource[]): Promise<void> {
    if (resources.length === 0) {
      return;
    }
    // One statement, unnesting parallel arrays, so all rows share one fetch
    // time and one round-trip.
    await this.pool.query(
      `INSERT INTO resource_cache (tenant_id, connection_id, resource_id, parent_id, resource)
       SELECT $1, $2, r.id, r.parent_id, r.resource
         FROM unnest($3::text[], $4::text[], $5::jsonb[]) AS r(id, parent_id, resource)
       ON CONFLICT (tenant_id, connection_id, resource_id)
       DO UPDATE SET parent_id = excluded.parent_id,
                     resource  = excluded.resource,
                     fetched_at = now()`,
      [
        scope.tenantId,
        scope.connectionId,
        resources.map((r) => r.id),
        resources.map((r) => r.parentId),
        resources.map((r) => JSON.stringify(r)),
      ],
    );
  }

  async delete(scope: CacheScope, resourceId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      `DELETE FROM resource_cache
        WHERE tenant_id = $1 AND connection_id = $2 AND resource_id = $3`,
      [scope.tenantId, scope.connectionId, resourceId],
    );
    return (rowCount ?? 0) > 0;
  }

  async list(scope: CacheScope, options: CacheListOptions = {}): Promise<CachedResource[]> {
    const byParent = 'parentId' in options;
    const { rows } = await this.pool.query<CacheRow>(
      `SELECT resource, fetched_at
         FROM resource_cache
        WHERE tenant_id = $1 AND connection_id = $2
          AND ($3::boolean IS FALSE OR parent_id IS NOT DISTINCT FROM $4)
        ORDER BY resource_id`,
      [scope.tenantId, scope.connectionId, byParent, byParent ? (options.parentId ?? null) : null],
    );
    return rows.map(toCached);
  }

  async prune(
    scope: CacheScope,
    keep: ReadonlySet<string>,
    options: CacheListOptions = {},
  ): Promise<number> {
    const byParent = 'parentId' in options;
    const { rowCount } = await this.pool.query(
      `DELETE FROM resource_cache
        WHERE tenant_id = $1 AND connection_id = $2
          AND ($3::boolean IS FALSE OR parent_id IS NOT DISTINCT FROM $4)
          AND resource_id <> ALL ($5::text[])`,
      [
        scope.tenantId,
        scope.connectionId,
        byParent,
        byParent ? (options.parentId ?? null) : null,
        [...keep],
      ],
    );
    return rowCount ?? 0;
  }
}

function toCached(row: CacheRow): CachedResource {
  return { resource: reviveDates(row.resource), fetchedAt: row.fetched_at };
}

/**
 * A Resource's `createdAt`/`updatedAt` are Dates, but jsonb round-trips them as
 * ISO strings — bring them back to Dates so a cached resource is identical to a
 * freshly fetched one.
 */
function reviveDates(resource: Resource): Resource {
  return {
    ...resource,
    createdAt: resource.createdAt ? new Date(resource.createdAt) : null,
    updatedAt: resource.updatedAt ? new Date(resource.updatedAt) : null,
  };
}
