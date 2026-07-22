// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Port: the registry of a tenant's connections.
 *
 * A connection is "this tenant authorised this connector" — the record, not
 * the secret. The secret lives in the credential vault, keyed by the
 * connection's id. Keeping the two apart is deliberate: this table can be read
 * freely (to list what is connected, to check status) without touching
 * anything encrypted.
 */

export type ConnectionStatus = 'active' | 'expired' | 'revoked' | 'error';

export interface Connection {
  readonly id: string;
  readonly tenantId: string;
  /** Which connector, e.g. "google-drive", "confluence", "notion". */
  readonly connectorId: string;
  /** Human-readable label for the connected account, for operators. */
  readonly accountLabel: string | null;
  readonly status: ConnectionStatus;
  /** Scopes granted, as the provider names them. */
  readonly scopes: readonly string[];
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateConnectionInput {
  readonly tenantId: string;
  readonly connectorId: string;
  readonly accountLabel?: string;
  readonly scopes?: readonly string[];
}

export class ConnectionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConnectionError';
  }
}

/** Every method is tenant-scoped: no read or change crosses the tenant boundary. */
export interface ConnectionStore {
  create(input: CreateConnectionInput): Promise<Connection>;
  find(tenantId: string, id: string): Promise<Connection | null>;
  /** A tenant's connections, optionally narrowed to one connector. */
  list(tenantId: string, connectorId?: string): Promise<Connection[]>;
  setStatus(tenantId: string, id: string, status: ConnectionStatus): Promise<Connection>;
  /** Remove the connection record. The caller forgets the credential separately. */
  remove(tenantId: string, id: string): Promise<boolean>;
}
