// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: module pools in PostgreSQL.
 *
 * The primary key is (tenant_id, module_id, key), so isolation is structural:
 * a query for one module's data cannot return another's, and there is no code
 * path that forgets to scope by both.
 */

import type { Pool } from 'pg';

import type { PoolEntry, PoolScope, PoolStore } from './pool-store.js';
import { assertValidKey } from './pool-store.js';

interface EntryRow {
  key: string;
  value: unknown;
  updated_at: Date;
}

export class PostgresPoolStore implements PoolStore {
  constructor(private readonly pool: Pool) {}

  async get(scope: PoolScope, key: string): Promise<PoolEntry | null> {
    assertValidKey(key);
    const { rows } = await this.pool.query<EntryRow>(
      `SELECT key, value, updated_at
         FROM module_pools
        WHERE tenant_id = $1 AND module_id = $2 AND key = $3`,
      [scope.tenantId, scope.moduleId, key],
    );

    const row = rows[0];
    return row ? toEntry(row) : null;
  }

  async set(scope: PoolScope, key: string, value: unknown): Promise<void> {
    assertValidKey(key);
    await this.pool.query(
      `INSERT INTO module_pools (tenant_id, module_id, key, value)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, module_id, key)
       DO UPDATE SET value = excluded.value, updated_at = now()`,
      [scope.tenantId, scope.moduleId, key, JSON.stringify(value)],
    );
  }

  async delete(scope: PoolScope, key: string): Promise<boolean> {
    assertValidKey(key);
    const { rowCount } = await this.pool.query(
      `DELETE FROM module_pools
        WHERE tenant_id = $1 AND module_id = $2 AND key = $3`,
      [scope.tenantId, scope.moduleId, key],
    );
    return (rowCount ?? 0) > 0;
  }

  async list(scope: PoolScope, keyPrefix?: string): Promise<PoolEntry[]> {
    const { rows } = await this.pool.query<EntryRow>(
      `SELECT key, value, updated_at
         FROM module_pools
        WHERE tenant_id = $1 AND module_id = $2
          AND ($3::text IS NULL OR key LIKE $3 || '%')
        ORDER BY key`,
      [scope.tenantId, scope.moduleId, keyPrefix ?? null],
    );
    return rows.map(toEntry);
  }
}

function toEntry(row: EntryRow): PoolEntry {
  return { key: row.key, value: row.value, updatedAt: row.updated_at };
}
