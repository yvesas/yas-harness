// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The transparent refresh. What matters: a fresh token passes through
 * untouched, a stale one is refreshed and stored back, and an unrefreshable
 * one fails in a way the manager can act on.
 */

import { randomBytes } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Connection } from '../../src/connections/connection-store.js';
import { CredentialVault } from '../../src/connections/credential-vault.js';
import { EnvelopeCipher } from '../../src/connections/envelope-cipher.js';
import {
  InMemoryCredentialStore,
  InMemoryTenantKeyStore,
} from '../../src/connections/in-memory-connection-store.js';
import { OAuthClient } from '../../src/connections/oauth.js';
import type { OAuthProvider, OAuthToken } from '../../src/connections/oauth.js';
import {
  OAuthRefreshError,
  OAuthTokenRefresher,
} from '../../src/connections/oauth-token-refresher.js';

const TENANT = 'tenant-1';
const NOW = new Date('2026-07-23T12:00:00.000Z');

const provider: OAuthProvider = {
  authorizationEndpoint: 'https://auth/authorize',
  tokenEndpoint: 'https://auth/token',
  clientId: 'c',
  clientSecret: 's',
  scopes: ['read'],
};

function connection(connectorId = 'atlassian'): Connection {
  return {
    id: 'conn-1',
    tenantId: TENANT,
    connectorId,
    accountLabel: null,
    status: 'active',
    scopes: [],
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function token(expiresAt: string | null, refreshToken: string | null = 'rt-1'): OAuthToken {
  return { accessToken: 'at-1', refreshToken, tokenType: 'Bearer', expiresAt, scope: null };
}

let vault: CredentialVault;

beforeEach(() => {
  vault = new CredentialVault(
    new EnvelopeCipher(randomBytes(32)),
    new InMemoryTenantKeyStore(),
    new InMemoryCredentialStore(),
  );
});

function refresher(fetch: typeof globalThis.fetch, providers = new Map([['atlassian', provider]])) {
  const client = new OAuthClient({ fetch, now: () => NOW });
  return new OAuthTokenRefresher(vault, client, providers, { now: () => NOW });
}

function stubFetch(payload: unknown) {
  const fetch = vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );
  return { fetch: fetch as unknown as typeof globalThis.fetch, fetchSpy: fetch };
}

describe('OAuthTokenRefresher', () => {
  it('returns a still-valid token without calling the provider', async () => {
    const future = new Date(NOW.getTime() + 3600_000).toISOString();
    await vault.store(TENANT, 'conn-1', token(future));
    const { fetch, fetchSpy } = stubFetch({});

    const resolved = await refresher(fetch).resolve(connection());

    expect(resolved).toEqual(token(future));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('refreshes an expired token and stores the new one back', async () => {
    const past = new Date(NOW.getTime() - 1000).toISOString();
    await vault.store(TENANT, 'conn-1', token(past));
    const { fetch } = stubFetch({ access_token: 'at-2', refresh_token: 'rt-2', expires_in: 3600 });

    const resolved = (await refresher(fetch).resolve(connection())) as OAuthToken;

    expect(resolved.accessToken).toBe('at-2');
    // The refreshed token is persisted, so the next call finds it valid.
    const stored = (await vault.resolve(TENANT, 'conn-1')) as OAuthToken;
    expect(stored.accessToken).toBe('at-2');
    expect(stored.refreshToken).toBe('rt-2');
  });

  it('refreshes a token inside the skew window before it actually expires', async () => {
    const soon = new Date(NOW.getTime() + 30_000).toISOString(); // 30s away, 60s skew
    await vault.store(TENANT, 'conn-1', token(soon));
    const { fetch, fetchSpy } = stubFetch({ access_token: 'at-2', expires_in: 3600 });

    await refresher(fetch).resolve(connection());

    expect(fetchSpy).toHaveBeenCalledOnce();
  });

  it('fails with a non-retryable error when there is nothing to refresh with', async () => {
    const past = new Date(NOW.getTime() - 1000).toISOString();
    await vault.store(TENANT, 'conn-1', token(past, null)); // no refresh token
    const { fetch } = stubFetch({});

    await expect(refresher(fetch).resolve(connection())).rejects.toMatchObject({
      name: 'OAuthRefreshError',
      detail: { retryable: false },
    });
  });

  it('wraps a provider failure as an OAuthRefreshError, carrying retryability', async () => {
    const past = new Date(NOW.getTime() - 1000).toISOString();
    await vault.store(TENANT, 'conn-1', token(past));
    const fetch = vi.fn(() =>
      Promise.resolve(new Response('down', { status: 503 })),
    ) as unknown as typeof globalThis.fetch;

    await expect(refresher(fetch).resolve(connection())).rejects.toMatchObject({
      name: 'OAuthRefreshError',
      detail: { retryable: true },
    });
  });

  it('returns a non-OAuth connector’s credential untouched', async () => {
    await vault.store(TENANT, 'conn-1', { apiKey: 'static-key' });
    const { fetch, fetchSpy } = stubFetch({});

    // No provider configured for this connector: not OAuth-managed.
    const resolved = await refresher(fetch, new Map()).resolve(connection('some-api'));

    expect(resolved).toEqual({ apiKey: 'static-key' });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('returns null when the connection has no stored credential', async () => {
    const { fetch } = stubFetch({});

    expect(await refresher(fetch).resolve(connection())).toBeNull();
  });

  it('exposes OAuthRefreshError for the manager to catch', () => {
    expect(new OAuthRefreshError('x', { connectionId: 'c', retryable: false })).toBeInstanceOf(
      Error,
    );
  });
});
