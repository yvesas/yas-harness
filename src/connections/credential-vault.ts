// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The credential vault: store and resolve a connection's secrets, encrypted.
 *
 * This is the one place that turns a secret into ciphertext and back. Only the
 * connection layer calls `resolve`, and only at the moment of a call — the
 * agent and the core never touch it. That is what "the agent never sees API
 * keys" means in practice: it sees method names and results, not credentials.
 */

import type { EnvelopeCipher, Sealed } from './envelope-cipher.js';

/**
 * Port: where a tenant's sealed data key lives.
 *
 * `ensure` is atomic — the first caller for a tenant stores a key, and every
 * caller (including a concurrent one that generated its own) gets back the one
 * that won. The store never generates a key; the vault does.
 */
export interface TenantKeyStore {
  ensure(tenantId: string, sealed: Sealed): Promise<Sealed>;
  find(tenantId: string): Promise<Sealed | null>;
}

/** Port: where a connection's sealed secret lives, keyed by connection. */
export interface CredentialStore {
  put(tenantId: string, connectionId: string, sealed: Sealed): Promise<void>;
  get(tenantId: string, connectionId: string): Promise<Sealed | null>;
  delete(tenantId: string, connectionId: string): Promise<boolean>;
}

export class VaultError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'VaultError';
  }
}

export class CredentialVault {
  readonly #cipher: EnvelopeCipher;
  readonly #keys: TenantKeyStore;
  readonly #credentials: CredentialStore;
  /** Data keys held only for this process's lifetime, never persisted in clear. */
  readonly #dekCache = new Map<string, Buffer>();

  constructor(cipher: EnvelopeCipher, keys: TenantKeyStore, credentials: CredentialStore) {
    this.#cipher = cipher;
    this.#keys = keys;
    this.#credentials = credentials;
  }

  /** Encrypt and store a connection's secret. The secret is any JSON value. */
  async store(tenantId: string, connectionId: string, secret: unknown): Promise<void> {
    const dek = await this.#dataKey(tenantId);
    const sealed = this.#cipher.seal(JSON.stringify(secret), dek);
    await this.#credentials.put(tenantId, connectionId, sealed);
  }

  /**
   * Decrypt a connection's secret, or null if there is none.
   *
   * The only method that returns a credential in the clear. Keep its result on
   * the stack — pass it to the outbound call and let it go; do not log it, do
   * not store it, do not hand it to the model.
   */
  async resolve<T = unknown>(tenantId: string, connectionId: string): Promise<T | null> {
    const sealed = await this.#credentials.get(tenantId, connectionId);
    if (sealed === null) {
      return null;
    }
    const dek = await this.#dataKey(tenantId);
    try {
      return JSON.parse(this.#cipher.open(sealed, dek)) as T;
    } catch (error) {
      throw new VaultError(`cannot resolve credential for connection "${connectionId}"`, {
        cause: error,
      });
    }
  }

  forget(tenantId: string, connectionId: string): Promise<boolean> {
    return this.#credentials.delete(tenantId, connectionId);
  }

  /** Get-or-create the tenant's data key, cached for the process lifetime. */
  async #dataKey(tenantId: string): Promise<Buffer> {
    const cached = this.#dekCache.get(tenantId);
    if (cached) {
      return cached;
    }

    const existing = await this.#keys.find(tenantId);
    const sealed = existing ?? this.#cipher.newDataKey().sealed;
    // ensure() resolves the race: whoever stored first wins, and everyone
    // opens the same sealed key. The DEK we may have just generated and lost
    // is simply discarded.
    const effective = existing ?? (await this.#keys.ensure(tenantId, sealed));
    const dek = this.#cipher.openDataKey(effective);

    this.#dekCache.set(tenantId, dek);
    return dek;
  }
}
