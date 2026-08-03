// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Bring your own model: a tenant paying their own provider, on their own key.
 *
 * Two reasons a customer asks for this, and they are different. **Money** — an
 * enterprise with a negotiated rate would rather spend it than pay a margin on
 * ours. And **data** — a regulated one wants its prompts landing in an account
 * it holds a contract with, which is a stronger statement than any promise the
 * platform can make about its own.
 *
 * The rule the whole design rests on:
 *
 * > **Bringing a key is opting out of the platform's.**
 *
 * A tenant with no keys is routed exactly as before, on ours. A tenant with
 * *any* key is routed only to providers they have a key for; if none of the
 * candidates for a task is covered, the call **fails** rather than quietly
 * falling back to ours. The alternative — falling back — would send that
 * tenant's data to a provider they deliberately did not choose, and bill us for
 * the privilege. Silence there is the failure mode worth engineering against,
 * because it looks like everything working.
 *
 * The key itself is decrypted for **one provider, at the moment of the call**,
 * never as a set. `providers` answers the routing question without unsealing
 * anything, so a request that ends up on Anthropic never decrypts the key for
 * Groq.
 */

import type { EnvelopeCipher, Sealed } from '../connections/envelope-cipher.js';
import type { TenantKeyStore } from '../connections/credential-vault.js';

/**
 * Port: a tenant's own provider keys.
 *
 * Split in two on purpose. `providers` is asked on every request and must be
 * cheap and secret-free; `resolve` unseals, and is asked once, for the provider
 * actually being called.
 */
export interface ModelKeys {
  /** Providers this tenant brought a key for. Empty means "use the platform's". */
  providers(tenantId: string): Promise<readonly string[]>;
  /** The key for one provider, or null if this tenant brought none for it. */
  resolve(tenantId: string, provider: string): Promise<string | null>;
}

/** Port: where a sealed model key lives. Mirrors `CredentialStore`. */
export interface ModelKeyStore {
  put(tenantId: string, provider: string, sealed: Sealed): Promise<void>;
  get(tenantId: string, provider: string): Promise<Sealed | null>;
  delete(tenantId: string, provider: string): Promise<boolean>;
  /** Which providers this tenant has a key for. Must not unseal anything. */
  providers(tenantId: string): Promise<string[]>;
}

export class ModelKeyError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ModelKeyError';
  }
}

/**
 * Model keys under the same envelope as every other secret.
 *
 * It reuses `TenantKeyStore` rather than introducing a second per-tenant data
 * key: one tenant, one DEK, so revoking or rotating it covers everything that
 * tenant owns. What differs is only where the ciphertext is filed.
 */
export class ModelKeyVault implements ModelKeys {
  readonly #cipher: EnvelopeCipher;
  readonly #tenantKeys: TenantKeyStore;
  readonly #store: ModelKeyStore;
  /** Data keys held only for this process's lifetime, as the vault does. */
  readonly #dekCache = new Map<string, Buffer>();

  constructor(cipher: EnvelopeCipher, tenantKeys: TenantKeyStore, store: ModelKeyStore) {
    this.#cipher = cipher;
    this.#tenantKeys = tenantKeys;
    this.#store = store;
  }

  providers(tenantId: string): Promise<readonly string[]> {
    return this.#store.providers(tenantId);
  }

  async store(tenantId: string, provider: string, apiKey: string): Promise<void> {
    if (apiKey.length === 0) {
      // An empty key would seal, store and then fail at the provider — as an
      // auth error, three layers from the mistake.
      throw new ModelKeyError(`the model key for "${provider}" is empty`);
    }
    // Created if this is the tenant's first secret of any kind: BYOM must not
    // require them to connect a source first, and a data key is theirs either
    // way.
    const dek = await this.#dataKeyForWriting(tenantId);
    await this.#store.put(tenantId, provider, this.#cipher.seal(apiKey, dek));
  }

  async resolve(tenantId: string, provider: string): Promise<string | null> {
    const sealed = await this.#store.get(tenantId, provider);
    if (!sealed) {
      return null;
    }
    const dek = await this.#dataKeyForReading(tenantId);
    return this.#cipher.open(sealed, dek);
  }

  forget(tenantId: string, provider: string): Promise<boolean> {
    return this.#store.delete(tenantId, provider);
  }

  /** Get-or-create: a tenant storing their first secret must not have to have one. */
  async #dataKeyForWriting(tenantId: string): Promise<Buffer> {
    const cached = this.#dekCache.get(tenantId);
    if (cached) {
      return cached;
    }

    const existing = await this.#tenantKeys.find(tenantId);
    // `ensure` resolves the race: whoever stored first wins and everyone opens
    // the same key, so a DEK generated and lost here is simply discarded.
    const effective =
      existing ?? (await this.#tenantKeys.ensure(tenantId, this.#cipher.newDataKey().sealed));
    const dek = this.#cipher.openDataKey(effective);
    this.#dekCache.set(tenantId, dek);
    return dek;
  }

  /**
   * Read-only: never creates.
   *
   * Reaching here means a sealed key was found, so the data key that sealed it
   * must exist. Its absence is a broken store, and minting a fresh one would
   * turn that into a decryption failure further along — or, worse, leave a key
   * behind for a tenant that stored nothing.
   */
  async #dataKeyForReading(tenantId: string): Promise<Buffer> {
    const cached = this.#dekCache.get(tenantId);
    if (cached) {
      return cached;
    }

    const sealed = await this.#tenantKeys.find(tenantId);
    if (!sealed) {
      throw new ModelKeyError(
        `tenant "${tenantId}" has a sealed model key but no data key to open it`,
      );
    }
    const dek = this.#cipher.openDataKey(sealed);
    this.#dekCache.set(tenantId, dek);
    return dek;
  }
}

/** For tests and for running without a database. Keys are held in the clear. */
export class InMemoryModelKeys implements ModelKeys {
  readonly #keys = new Map<string, string>();

  set(tenantId: string, provider: string, apiKey: string): void {
    this.#keys.set(`${tenantId}:${provider}`, apiKey);
  }

  providers(tenantId: string): Promise<readonly string[]> {
    const prefix = `${tenantId}:`;
    return Promise.resolve(
      [...this.#keys.keys()]
        .filter((key) => key.startsWith(prefix))
        .map((key) => key.slice(prefix.length)),
    );
  }

  resolve(tenantId: string, provider: string): Promise<string | null> {
    return Promise.resolve(this.#keys.get(`${tenantId}:${provider}`) ?? null);
  }
}
