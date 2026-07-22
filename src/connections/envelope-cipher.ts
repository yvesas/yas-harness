// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Envelope encryption for stored credentials.
 *
 * A master key (the KEK, controlled by the operator) never encrypts a
 * credential directly. It wraps a per-tenant data key (a DEK); the DEK
 * encrypts that tenant's credentials. This buys two things the plan asks for:
 *
 *  - Isolation. Compromising one tenant's DEK exposes only that tenant.
 *  - Rotation. Rotating the master key re-wraps the DEKs — a handful of small
 *    blobs — without touching the credentials themselves.
 *
 * Everything here is AES-256-GCM (authenticated encryption) over Node's own
 * crypto, so a tampered blob fails to open rather than decrypting to garbage.
 * No dependency: the surface used is four calls wide.
 */

import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const KEY_BYTES = 32; // AES-256
const IV_BYTES = 12; // GCM standard nonce
const TAG_BYTES = 16; // GCM authentication tag

/**
 * A sealed blob: iv ‖ tag ‖ ciphertext, one opaque buffer. Callers store it
 * and hand it back to open; they never pick it apart.
 */
export type Sealed = Buffer;

export class CipherError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CipherError';
  }
}

export class EnvelopeCipher {
  readonly #masterKey: Buffer;

  constructor(masterKey: Buffer) {
    if (masterKey.length !== KEY_BYTES) {
      throw new CipherError(`master key must be ${KEY_BYTES} bytes, got ${masterKey.length}`);
    }
    this.#masterKey = masterKey;
  }

  /** Read the master key from a base64 string, e.g. `openssl rand -base64 32`. */
  static fromBase64(masterKey: string): EnvelopeCipher {
    const key = Buffer.from(masterKey, 'base64');
    if (key.length !== KEY_BYTES) {
      throw new CipherError(
        `MASTER_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes; got ${key.length}. ` +
          'Generate one with: openssl rand -base64 32',
      );
    }
    return new EnvelopeCipher(key);
  }

  /** A fresh data key, plus that key sealed under the master key for storage. */
  newDataKey(): { readonly key: Buffer; readonly sealed: Sealed } {
    const key = randomBytes(KEY_BYTES);
    return { key, sealed: seal(key, this.#masterKey) };
  }

  /** Recover a data key from its sealed form. Throws if the blob was tampered. */
  openDataKey(sealed: Sealed): Buffer {
    const key = open(sealed, this.#masterKey, 'data key');
    if (key.length !== KEY_BYTES) {
      throw new CipherError(`unsealed data key has wrong length: ${key.length}`);
    }
    return key;
  }

  /** Seal a secret under a data key. */
  seal(plaintext: string, dataKey: Buffer): Sealed {
    if (dataKey.length !== KEY_BYTES) {
      throw new CipherError(`data key must be ${KEY_BYTES} bytes, got ${dataKey.length}`);
    }
    return seal(Buffer.from(plaintext, 'utf8'), dataKey);
  }

  /** Open a secret sealed under a data key. Throws if tampered or wrong key. */
  open(sealed: Sealed, dataKey: Buffer): string {
    return open(sealed, dataKey, 'credential').toString('utf8');
  }
}

function seal(plaintext: Buffer, key: Buffer): Sealed {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, ciphertext]);
}

function open(sealed: Sealed, key: Buffer, what: string): Buffer {
  if (sealed.length < IV_BYTES + TAG_BYTES) {
    throw new CipherError(`sealed ${what} is too short to be valid`);
  }
  const iv = sealed.subarray(0, IV_BYTES);
  const tag = sealed.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
  const ciphertext = sealed.subarray(IV_BYTES + TAG_BYTES);

  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  try {
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch (error) {
    // GCM authentication failed: wrong key, or the blob was altered.
    throw new CipherError(`cannot open sealed ${what}: authentication failed`, { cause: error });
  }
}
