// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapters: the connection layer's three stores in process memory.
 *
 * For tests and for running without a database. They enforce the same tenant
 * scoping the Postgres adapters do. The credential store holds sealed bytes,
 * exactly as the table does — it never sees a plaintext secret.
 */

import type {
  Connection,
  ConnectionStatus,
  ConnectionStore,
  CreateConnectionInput,
} from './connection-store.js';
import { ConnectionError } from './connection-store.js';
import type { CredentialStore, TenantKeyStore } from './credential-vault.js';
import type { Sealed } from './envelope-cipher.js';

// These adapters do no I/O; they are async so their methods reject rather than
// throw synchronously, matching the Postgres adapters and what callers expect.
/* eslint-disable @typescript-eslint/require-await */

export class InMemoryConnectionStore implements ConnectionStore {
  readonly #connections = new Map<string, Connection>();
  #counter = 0;

  async create(input: CreateConnectionInput): Promise<Connection> {
    this.#counter += 1;
    const now = new Date(this.#counter * 1000);
    const connection: Connection = {
      id: `connection-${this.#counter}`,
      tenantId: input.tenantId,
      connectorId: input.connectorId,
      accountLabel: input.accountLabel ?? null,
      status: 'active',
      scopes: input.scopes ?? [],
      createdAt: now,
      updatedAt: now,
    };
    this.#connections.set(connection.id, connection);
    return connection;
  }

  async find(tenantId: string, id: string): Promise<Connection | null> {
    const connection = this.#connections.get(id);
    return connection && connection.tenantId === tenantId ? connection : null;
  }

  async list(tenantId: string, connectorId?: string): Promise<Connection[]> {
    return [...this.#connections.values()]
      .filter(
        (connection) =>
          connection.tenantId === tenantId &&
          (connectorId === undefined || connection.connectorId === connectorId),
      )
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async setStatus(tenantId: string, id: string, status: ConnectionStatus): Promise<Connection> {
    const connection = await this.find(tenantId, id);
    if (!connection) {
      throw new ConnectionError(`connection "${id}" not found for tenant "${tenantId}"`);
    }
    this.#counter += 1;
    const updated: Connection = {
      ...connection,
      status,
      updatedAt: new Date(this.#counter * 1000),
    };
    this.#connections.set(id, updated);
    return updated;
  }

  async remove(tenantId: string, id: string): Promise<boolean> {
    const connection = await this.find(tenantId, id);
    if (!connection) {
      return false;
    }
    return this.#connections.delete(id);
  }
}

export class InMemoryTenantKeyStore implements TenantKeyStore {
  readonly #keys = new Map<string, Sealed>();

  async ensure(tenantId: string, sealed: Sealed): Promise<Sealed> {
    const existing = this.#keys.get(tenantId);
    if (existing) {
      return existing;
    }
    // Copy so a caller cannot mutate the stored bytes through its reference.
    const stored = Buffer.from(sealed);
    this.#keys.set(tenantId, stored);
    return stored;
  }

  async find(tenantId: string): Promise<Sealed | null> {
    return this.#keys.get(tenantId) ?? null;
  }
}

export class InMemoryCredentialStore implements CredentialStore {
  readonly #secrets = new Map<string, Sealed>();

  async put(tenantId: string, connectionId: string, sealed: Sealed): Promise<void> {
    this.#secrets.set(this.#id(tenantId, connectionId), Buffer.from(sealed));
  }

  async get(tenantId: string, connectionId: string): Promise<Sealed | null> {
    return this.#secrets.get(this.#id(tenantId, connectionId)) ?? null;
  }

  async delete(tenantId: string, connectionId: string): Promise<boolean> {
    return this.#secrets.delete(this.#id(tenantId, connectionId));
  }

  #id(tenantId: string, connectionId: string): string {
    return `${tenantId.length}:${tenantId}/${connectionId}`;
  }
}
