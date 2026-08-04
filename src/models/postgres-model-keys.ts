// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: a tenant's sealed model keys in PostgreSQL.
 *
 * Moves bytes and nothing else. It never sees a plaintext key or the master
 * key — that is `ModelKeyVault`'s job, and keeping the split means a database
 * dump is not a set of credentials.
 */

import type { Pool } from 'pg';

import type { Sealed } from '../connections/envelope-cipher.js';
import type { ModelKeyStore } from './model-keys.js';

export class PostgresModelKeyStore implements ModelKeyStore {
  constructor(private readonly pool: Pool) {}

  async put(tenantId: string, provider: string, sealed: Sealed): Promise<void> {
    await this.pool.query(
      `INSERT INTO tenant_model_keys (tenant_id, provider, sealed_secret)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, provider)
       DO UPDATE SET sealed_secret = excluded.sealed_secret, updated_at = now()`,
      [tenantId, provider, sealed],
    );
  }

  async get(tenantId: string, provider: string): Promise<Sealed | null> {
    const { rows } = await this.pool.query<{ sealed_secret: Buffer }>(
      'SELECT sealed_secret FROM tenant_model_keys WHERE tenant_id = $1 AND provider = $2',
      [tenantId, provider],
    );
    return rows[0]?.sealed_secret ?? null;
  }

  async delete(tenantId: string, provider: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM tenant_model_keys WHERE tenant_id = $1 AND provider = $2',
      [tenantId, provider],
    );
    return (rowCount ?? 0) > 0;
  }

  async providers(tenantId: string): Promise<string[]> {
    // Only the names: this is asked on every request, and unsealing here would
    // decrypt a key for every provider to answer a routing question.
    const { rows } = await this.pool.query<{ provider: string }>(
      'SELECT provider FROM tenant_model_keys WHERE tenant_id = $1 ORDER BY provider',
      [tenantId],
    );
    return rows.map((row) => row.provider);
  }
}
