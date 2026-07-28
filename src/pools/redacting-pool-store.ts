// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A `PoolStore` decorator that redacts secrets from a value before it is stored.
 * A module's pool holds arbitrary JSON the product controls, which can carry a
 * credential it fetched or derived. The value is walked leaf by leaf on write;
 * reads, deletes and listing pass straight through.
 */

import { redactDeep, type SecretRedactor } from '../redaction/secret-redactor.js';

import type { PoolEntry, PoolScope, PoolStore } from './pool-store.js';

export class RedactingPoolStore implements PoolStore {
  readonly #inner: PoolStore;
  readonly #redactor: SecretRedactor;

  constructor(inner: PoolStore, redactor: SecretRedactor) {
    this.#inner = inner;
    this.#redactor = redactor;
  }

  get(scope: PoolScope, key: string): Promise<PoolEntry | null> {
    return this.#inner.get(scope, key);
  }

  set(scope: PoolScope, key: string, value: unknown): Promise<void> {
    return this.#inner.set(scope, key, redactDeep(this.#redactor, value));
  }

  delete(scope: PoolScope, key: string): Promise<boolean> {
    return this.#inner.delete(scope, key);
  }

  list(scope: PoolScope, keyPrefix?: string): Promise<PoolEntry[]> {
    return this.#inner.list(scope, keyPrefix);
  }
}
