// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapters: the connection layer's three stores in PostgreSQL.
 *
 * The connection registry, the per-tenant data key, and the sealed
 * credentials. The credential and key stores move only bytes — they never see
 * a plaintext secret or the master key, which is the vault's job.
 */

import type { Pool } from 'pg';

import type {
  Connection,
  ConnectionStatus,
  ConnectionStore,
  CreateConnectionInput,
} from './connection-store.js';
import type { CredentialStore, TenantKeyStore } from './credential-vault.js';
import type { Sealed } from './envelope-cipher.js';

interface ConnectionRow {
  id: string;
  tenant_id: string;
  connector_id: string;
  account_label: string | null;
  status: ConnectionStatus;
  scopes: string[];
  created_at: Date;
  updated_at: Date;
}

export class PostgresConnectionStore implements ConnectionStore {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateConnectionInput): Promise<Connection> {
    const { rows } = await this.pool.query<ConnectionRow>(
      `INSERT INTO connections (tenant_id, connector_id, account_label, scopes)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.tenantId, input.connectorId, input.accountLabel ?? null, input.scopes ?? []],
    );
    return toConnection(rows[0]!);
  }

  async find(tenantId: string, id: string): Promise<Connection | null> {
    const { rows } = await this.pool.query<ConnectionRow>(
      'SELECT * FROM connections WHERE id = $1 AND tenant_id = $2',
      [id, tenantId],
    );
    const row = rows[0];
    return row ? toConnection(row) : null;
  }

  async list(tenantId: string, connectorId?: string): Promise<Connection[]> {
    const { rows } = await this.pool.query<ConnectionRow>(
      `SELECT * FROM connections
        WHERE tenant_id = $1 AND ($2::text IS NULL OR connector_id = $2)
        ORDER BY created_at, id`,
      [tenantId, connectorId ?? null],
    );
    return rows.map(toConnection);
  }

  async setStatus(tenantId: string, id: string, status: ConnectionStatus): Promise<Connection> {
    const { rows } = await this.pool.query<ConnectionRow>(
      `UPDATE connections SET status = $3, updated_at = now()
        WHERE id = $1 AND tenant_id = $2
        RETURNING *`,
      [id, tenantId, status],
    );
    const row = rows[0];
    if (!row) {
      throw new Error(`connection "${id}" not found for tenant "${tenantId}"`);
    }
    return toConnection(row);
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM connections WHERE id = $1 AND tenant_id = $2',
      [id, tenantId],
    );
    return (rowCount ?? 0) > 0;
  }
}

export class PostgresTenantKeyStore implements TenantKeyStore {
  constructor(private readonly pool: Pool) {}

  async ensure(tenantId: string, sealed: Sealed): Promise<Sealed> {
    // Insert if absent; whether we won or lost the race, read back the row
    // that is actually stored so every caller opens the same data key.
    const { rows } = await this.pool.query<{ sealed_dek: Buffer }>(
      `INSERT INTO tenant_keys (tenant_id, sealed_dek)
       VALUES ($1, $2)
       ON CONFLICT (tenant_id) DO UPDATE SET tenant_id = excluded.tenant_id
       RETURNING sealed_dek`,
      [tenantId, sealed],
    );
    return rows[0]!.sealed_dek;
  }

  async find(tenantId: string): Promise<Sealed | null> {
    const { rows } = await this.pool.query<{ sealed_dek: Buffer }>(
      'SELECT sealed_dek FROM tenant_keys WHERE tenant_id = $1',
      [tenantId],
    );
    return rows[0]?.sealed_dek ?? null;
  }
}

export class PostgresCredentialStore implements CredentialStore {
  constructor(private readonly pool: Pool) {}

  async put(tenantId: string, connectionId: string, sealed: Sealed): Promise<void> {
    await this.pool.query(
      `INSERT INTO credentials (connection_id, tenant_id, sealed_secret)
       VALUES ($1, $2, $3)
       ON CONFLICT (connection_id)
       DO UPDATE SET sealed_secret = excluded.sealed_secret, updated_at = now()`,
      [connectionId, tenantId, sealed],
    );
  }

  async get(tenantId: string, connectionId: string): Promise<Sealed | null> {
    const { rows } = await this.pool.query<{ sealed_secret: Buffer }>(
      'SELECT sealed_secret FROM credentials WHERE connection_id = $1 AND tenant_id = $2',
      [connectionId, tenantId],
    );
    return rows[0]?.sealed_secret ?? null;
  }

  async delete(tenantId: string, connectionId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'DELETE FROM credentials WHERE connection_id = $1 AND tenant_id = $2',
      [connectionId, tenantId],
    );
    return (rowCount ?? 0) > 0;
  }
}

function toConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    connectorId: row.connector_id,
    accountLabel: row.account_label,
    status: row.status,
    scopes: row.scopes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
