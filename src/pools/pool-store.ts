// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Port: where a module keeps its own data.
 *
 * The harness gives every module a private, namespaced key-value space. It
 * does not define what a module stores — an expense, a meeting, a vocabulary
 * word are the product's concern. It defines only that the space exists and is
 * isolated: by tenant, and by module.
 *
 * A module never reaches into another module's pool. Crossing that boundary is
 * done by asking (phase 6), never by reading the other's rows.
 */

/** Identifies one module's slice of one tenant's data. */
export interface PoolScope {
  readonly tenantId: string;
  readonly moduleId: string;
}

export interface PoolEntry {
  readonly key: string;
  readonly value: unknown;
  readonly updatedAt: Date;
}

/**
 * Every method is scoped by both tenant and module: there is no read that
 * spans either boundary. Values are arbitrary JSON — the harness stores them,
 * the module gives them meaning.
 */
export interface PoolStore {
  get(scope: PoolScope, key: string): Promise<PoolEntry | null>;
  set(scope: PoolScope, key: string, value: unknown): Promise<void>;
  delete(scope: PoolScope, key: string): Promise<boolean>;
  /** Entries in this pool, optionally narrowed to a key prefix. */
  list(scope: PoolScope, keyPrefix?: string): Promise<PoolEntry[]>;
}

/** Keys a module may use: no empty, no absurd length. */
const KEY = /^[^\s][^\n]{0,254}$/;

export class PoolError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PoolError';
  }
}

export function assertValidKey(key: string): void {
  if (!KEY.test(key)) {
    throw new PoolError(`invalid pool key: ${JSON.stringify(key)}`);
  }
}
