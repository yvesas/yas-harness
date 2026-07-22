// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

import { randomBytes } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { CredentialVault, VaultError } from '../../src/connections/credential-vault.js';
import { EnvelopeCipher } from '../../src/connections/envelope-cipher.js';
import {
  InMemoryCredentialStore,
  InMemoryTenantKeyStore,
} from '../../src/connections/in-memory-connection-store.js';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const CONNECTION = 'connection-1';

function vault(cipher = new EnvelopeCipher(randomBytes(32))) {
  const keys = new InMemoryTenantKeyStore();
  const credentials = new InMemoryCredentialStore();
  return { vault: new CredentialVault(cipher, keys, credentials), keys, credentials, cipher };
}

describe('CredentialVault', () => {
  it('stores and resolves a secret', async () => {
    const { vault: v } = vault();
    await v.store(TENANT_A, CONNECTION, { accessToken: 'abc', refreshToken: 'def' });

    expect(await v.resolve(TENANT_A, CONNECTION)).toEqual({
      accessToken: 'abc',
      refreshToken: 'def',
    });
  });

  it('returns null when there is no credential', async () => {
    const { vault: v } = vault();

    expect(await v.resolve(TENANT_A, 'missing')).toBeNull();
  });

  it('overwrites on a second store', async () => {
    const { vault: v } = vault();
    await v.store(TENANT_A, CONNECTION, { token: 'old' });
    await v.store(TENANT_A, CONNECTION, { token: 'new' });

    expect(await v.resolve(TENANT_A, CONNECTION)).toEqual({ token: 'new' });
  });

  it('never stores the secret in the clear', async () => {
    const { vault: v, credentials } = vault();
    await v.store(TENANT_A, CONNECTION, { token: 'super-secret' });

    const sealed = await credentials.get(TENANT_A, CONNECTION);
    expect(sealed).not.toBeNull();
    expect(sealed!.toString('utf8')).not.toContain('super-secret');
    expect(sealed!.toString('latin1')).not.toContain('super-secret');
  });

  it('gives each tenant its own data key', async () => {
    const { vault: v, keys } = vault();
    await v.store(TENANT_A, CONNECTION, { token: 'a' });
    await v.store(TENANT_B, CONNECTION, { token: 'b' });

    const keyA = await keys.find(TENANT_A);
    const keyB = await keys.find(TENANT_B);
    expect(keyA).not.toBeNull();
    expect(keyA).not.toEqual(keyB);
  });

  it('cannot resolve another tenant’s credential', async () => {
    const { vault: v } = vault();
    await v.store(TENANT_A, CONNECTION, { token: 'a-secret' });

    // Same connection id, different tenant: the credential store is scoped, so
    // there is nothing to resolve.
    expect(await v.resolve(TENANT_B, CONNECTION)).toBeNull();
  });

  it('reuses the tenant’s data key across connections', async () => {
    const { vault: v, keys } = vault();
    await v.store(TENANT_A, 'conn-1', { token: '1' });
    await v.store(TENANT_A, 'conn-2', { token: '2' });

    // One key, two credentials, both resolvable.
    expect(await keys.find(TENANT_A)).not.toBeNull();
    expect(await v.resolve(TENANT_A, 'conn-1')).toEqual({ token: '1' });
    expect(await v.resolve(TENANT_A, 'conn-2')).toEqual({ token: '2' });
  });

  it('resolves what a cold vault (no DEK cache) sealed', async () => {
    // A restart: same cipher and stores, a fresh vault with an empty cache.
    const keys = new InMemoryTenantKeyStore();
    const credentials = new InMemoryCredentialStore();
    const cipher = new EnvelopeCipher(randomBytes(32));

    const writer = new CredentialVault(cipher, keys, credentials);
    await writer.store(TENANT_A, CONNECTION, { token: 'persisted' });

    const reader = new CredentialVault(cipher, keys, credentials);
    expect(await reader.resolve(TENANT_A, CONNECTION)).toEqual({ token: 'persisted' });
  });

  it('fails to resolve a secret sealed under a different master key', async () => {
    const keys = new InMemoryTenantKeyStore();
    const credentials = new InMemoryCredentialStore();

    const writer = new CredentialVault(new EnvelopeCipher(randomBytes(32)), keys, credentials);
    await writer.store(TENANT_A, CONNECTION, { token: 'x' });

    // A vault with the wrong master key cannot unwrap the tenant's DEK.
    const wrong = new CredentialVault(new EnvelopeCipher(randomBytes(32)), keys, credentials);
    await expect(wrong.resolve(TENANT_A, CONNECTION)).rejects.toThrow();
  });

  it('forgets a credential', async () => {
    const { vault: v } = vault();
    await v.store(TENANT_A, CONNECTION, { token: 'x' });

    expect(await v.forget(TENANT_A, CONNECTION)).toBe(true);
    expect(await v.resolve(TENANT_A, CONNECTION)).toBeNull();
    expect(await v.forget(TENANT_A, CONNECTION)).toBe(false);
  });

  it('wraps a corrupt-credential failure in a VaultError', async () => {
    const { vault: v, credentials } = vault();
    await v.store(TENANT_A, CONNECTION, { token: 'x' });

    // Corrupt the stored blob.
    const sealed = await credentials.get(TENANT_A, CONNECTION);
    const last = sealed!.length - 1;
    sealed!.writeUInt8(sealed!.readUInt8(last) ^ 0xff, last);

    await expect(v.resolve(TENANT_A, CONNECTION)).rejects.toBeInstanceOf(VaultError);
  });
});
