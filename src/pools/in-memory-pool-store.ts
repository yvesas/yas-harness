// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: module pools in process memory.
 *
 * For tests and for running modules without a database. It namespaces by
 * tenant and module exactly like the Postgres adapter — a looser double would
 * let an isolation bug pass the suite.
 */

import type { PoolEntry, PoolScope, PoolStore } from './pool-store.js';
import { assertValidKey } from './pool-store.js';

// The methods are async on purpose: they do no I/O, but being async turns a
// rejected key into a rejected promise rather than a synchronous throw, which
// is the shape the Postgres adapter has and the shape callers expect.
/* eslint-disable @typescript-eslint/require-await */

export class InMemoryPoolStore implements PoolStore {
  readonly #entries = new Map<string, PoolEntry>();
  #clock = 0;

  // Bodies are synchronous, but the methods are async so that a rejected key
  // surfaces as a rejected promise — the same shape the Postgres adapter has.
  async get(scope: PoolScope, key: string): Promise<PoolEntry | null> {
    assertValidKey(key);
    return this.#entries.get(this.#id(scope, key)) ?? null;
  }

  async set(scope: PoolScope, key: string, value: unknown): Promise<void> {
    assertValidKey(key);
    this.#clock += 1;
    // Clone so callers cannot mutate a stored value by holding the reference
    // they passed in — the Postgres adapter can't be mutated that way either.
    this.#entries.set(this.#id(scope, key), {
      key,
      value: structuredClone(value),
      updatedAt: new Date(this.#clock * 1000),
    });
  }

  async delete(scope: PoolScope, key: string): Promise<boolean> {
    assertValidKey(key);
    return this.#entries.delete(this.#id(scope, key));
  }

  async list(scope: PoolScope, keyPrefix?: string): Promise<PoolEntry[]> {
    const prefix = this.#id(scope, keyPrefix ?? '');
    return [...this.#entries.entries()]
      .filter(([id]) => id.startsWith(prefix))
      .map(([, entry]) => entry)
      .sort((a, b) => a.key.localeCompare(b.key));
  }

  #id(scope: PoolScope, key: string): string {
    // The tenant and module segments are length-prefixed so no combination of
    // ids and key can collide with a different scope's namespace.
    return `${scope.tenantId.length}:${scope.tenantId}/${scope.moduleId.length}:${scope.moduleId}/${key}`;
  }
}
