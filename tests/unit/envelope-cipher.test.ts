// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The envelope cipher. This is security-critical, so the tests check not just
 * that it round-trips, but that it refuses tampered input, that a wrong key
 * cannot open a blob, and that the wrap/unwrap of data keys holds.
 */

import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CipherError, EnvelopeCipher } from '../../src/connections/envelope-cipher.js';

function cipher(): EnvelopeCipher {
  return new EnvelopeCipher(randomBytes(32));
}

describe('EnvelopeCipher', () => {
  describe('master key', () => {
    it('rejects a master key of the wrong length', () => {
      expect(() => new EnvelopeCipher(randomBytes(16))).toThrow(CipherError);
    });

    it('reads a valid base64 master key', () => {
      const key = randomBytes(32).toString('base64');
      expect(() => EnvelopeCipher.fromBase64(key)).not.toThrow();
    });

    it('rejects a base64 master key that decodes to the wrong length', () => {
      const short = randomBytes(20).toString('base64');
      expect(() => EnvelopeCipher.fromBase64(short)).toThrowError(/must decode to 32 bytes/);
    });
  });

  describe('data keys', () => {
    it('wraps and unwraps a data key', () => {
      const c = cipher();
      const { key, sealed } = c.newDataKey();

      expect(c.openDataKey(sealed)).toEqual(key);
    });

    it('generates a distinct data key each time', () => {
      const c = cipher();
      expect(c.newDataKey().key).not.toEqual(c.newDataKey().key);
    });

    it('will not unwrap a data key under a different master key', () => {
      const { sealed } = cipher().newDataKey();

      expect(() => cipher().openDataKey(sealed)).toThrowError(/authentication failed/);
    });
  });

  describe('secrets', () => {
    it('seals and opens a secret under a data key', () => {
      const c = cipher();
      const { key } = c.newDataKey();

      const sealed = c.seal('super-secret-token', key);

      expect(c.open(sealed, key)).toBe('super-secret-token');
    });

    it('produces different ciphertext for the same plaintext (random IV)', () => {
      const c = cipher();
      const { key } = c.newDataKey();

      expect(c.seal('same', key)).not.toEqual(c.seal('same', key));
    });

    it('refuses to open a secret with the wrong data key', () => {
      const c = cipher();
      const sealed = c.seal('secret', c.newDataKey().key);

      expect(() => c.open(sealed, c.newDataKey().key)).toThrowError(/authentication failed/);
    });

    it('refuses to open a tampered blob', () => {
      const c = cipher();
      const { key } = c.newDataKey();
      const sealed = Buffer.from(c.seal('secret', key));
      const last = sealed.length - 1;
      sealed.writeUInt8(sealed.readUInt8(last) ^ 0xff, last); // flip a ciphertext byte

      expect(() => c.open(sealed, key)).toThrow(CipherError);
    });

    it('refuses a blob too short to be valid', () => {
      const c = cipher();
      expect(() => c.open(Buffer.alloc(4), c.newDataKey().key)).toThrowError(/too short/);
    });

    it('round-trips unicode and long secrets', () => {
      const c = cipher();
      const { key } = c.newDataKey();
      const secret = 'ação·токен·🔑'.repeat(500);

      expect(c.open(c.seal(secret, key), key)).toBe(secret);
    });
  });

  describe('key rotation', () => {
    it('re-wraps a data key under a new master key without touching secrets', () => {
      const oldMaster = randomBytes(32);
      const newMaster = randomBytes(32);
      const oldCipher = new EnvelopeCipher(oldMaster);

      // A tenant DEK and a secret sealed under it.
      const { key: dek, sealed: wrapped } = oldCipher.newDataKey();
      const secret = oldCipher.seal('token', dek);

      // Rotate: unwrap the DEK with the old master, re-wrap with the new one.
      const bareDek = oldCipher.openDataKey(wrapped);
      const newCipher = new EnvelopeCipher(newMaster);
      const rewrapped = newCipher.seal(bareDek.toString('base64'), newMaster);
      // (The secret blob itself was never re-encrypted.)

      // The secret still opens under the DEK recovered from the new wrapping.
      const recoveredDek = Buffer.from(newCipher.open(rewrapped, newMaster), 'base64');
      expect(newCipher.open(secret, recoveredDek)).toBe('token');
    });
  });
});
