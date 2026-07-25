// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The manager with OAuth refresh wired in. This proves the two behaviours that
 * matter to a caller: a stale token is refreshed transparently and the call
 * succeeds, and a refresh that fails outright downgrades the connection to
 * expired so the next call fails fast rather than hammering the provider.
 */

import { randomBytes } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionManager } from '../../src/connections/connection-manager.js';
import type { ConnectorContext } from '../../src/connections/connector.js';
import { ConnectorRegistry } from '../../src/connections/connector-registry.js';
import { CredentialVault } from '../../src/connections/credential-vault.js';
import { EnvelopeCipher } from '../../src/connections/envelope-cipher.js';
import {
  InMemoryConnectionStore,
  InMemoryCredentialStore,
  InMemoryTenantKeyStore,
} from '../../src/connections/in-memory-connection-store.js';
import { MemoryConnector } from '../../src/connections/memory-connector.js';
import { OAuthClient } from '../../src/connections/oauth.js';
import type { OAuthProvider, OAuthToken } from '../../src/connections/oauth.js';
import { OAuthTokenRefresher } from '../../src/connections/oauth-token-refresher.js';

const TENANT = 'tenant-1';
const NOW = new Date('2026-07-23T12:00:00.000Z');

const provider: OAuthProvider = {
  authorizationEndpoint: 'https://auth/authorize',
  tokenEndpoint: 'https://auth/token',
  clientId: 'c',
  clientSecret: 's',
  scopes: ['read'],
};

let connections: InMemoryConnectionStore;
let vault: CredentialVault;
let connectors: ConnectorRegistry;

beforeEach(() => {
  connections = new InMemoryConnectionStore();
  vault = new CredentialVault(
    new EnvelopeCipher(randomBytes(32)),
    new InMemoryTenantKeyStore(),
    new InMemoryCredentialStore(),
  );
  connectors = new ConnectorRegistry().register(new MemoryConnector({ id: 'atlassian' }));
});

function managerWith(fetch: typeof globalThis.fetch): ConnectionManager {
  const refresher = new OAuthTokenRefresher(
    vault,
    new OAuthClient({ fetch, now: () => NOW }),
    new Map([['atlassian', provider]]),
    { now: () => NOW },
  );
  return new ConnectionManager(connectors, connections, refresher);
}

function expiredToken(): OAuthToken {
  return {
    accessToken: 'at-old',
    refreshToken: 'rt-1',
    tokenType: 'Bearer',
    expiresAt: new Date(NOW.getTime() - 1000).toISOString(),
    scope: null,
  };
}

async function connectionWith(token: OAuthToken): Promise<string> {
  const connection = await connections.create({ tenantId: TENANT, connectorId: 'atlassian' });
  await vault.store(TENANT, connection.id, token);
  return connection.id;
}

function okFetch(payload: unknown) {
  return vi.fn(() =>
    Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    ),
  ) as unknown as typeof globalThis.fetch;
}

describe('ConnectionManager with OAuth refresh', () => {
  it('refreshes a stale token and completes the operation with the fresh one', async () => {
    const connectionId = await connectionWith(expiredToken());
    // Capture what the connector was handed.
    let seen: ConnectorContext | undefined;
    connectors = new ConnectorRegistry();
    const connector = new MemoryConnector({ id: 'atlassian' });
    const originalCreate = connector.create.bind(connector);
    connector.create = (ctx, draft) => {
      seen = ctx;
      return originalCreate(ctx, draft);
    };
    connectors.register(connector);

    const manager = managerWith(okFetch({ access_token: 'at-new', expires_in: 3600 }));
    const created = await manager.create(TENANT, connectionId, { title: 'Page' });

    expect(created.title).toBe('Page');
    // The connector authenticated with the refreshed token, not the stale one.
    expect((seen?.credential as OAuthToken).accessToken).toBe('at-new');
  });

  it('leaves the connection active after a successful refresh', async () => {
    const connectionId = await connectionWith(expiredToken());
    const manager = managerWith(okFetch({ access_token: 'at-new', expires_in: 3600 }));

    await manager.list(TENANT, connectionId);

    expect((await connections.find(TENANT, connectionId))?.status).toBe('active');
  });

  it('downgrades the connection to expired when a refresh cannot recover', async () => {
    // Refresh token revoked at the provider: a 400 that is not retryable.
    const connectionId = await connectionWith(expiredToken());
    const failing = vi.fn(() =>
      Promise.resolve(new Response('invalid_grant', { status: 400 })),
    ) as unknown as typeof globalThis.fetch;
    const manager = managerWith(failing);

    await expect(manager.list(TENANT, connectionId)).rejects.toThrowError(/needs re-authorisation/);

    // And the connection is now expired, so a later call fails fast.
    expect((await connections.find(TENANT, connectionId))?.status).toBe('expired');
    await expect(manager.list(TENANT, connectionId)).rejects.toThrowError(/is expired, not active/);
  });

  it('does not refresh a token that is still valid', async () => {
    const valid: OAuthToken = {
      accessToken: 'at-valid',
      refreshToken: 'rt-1',
      tokenType: 'Bearer',
      expiresAt: new Date(NOW.getTime() + 3600_000).toISOString(),
      scope: null,
    };
    const connectionId = await connectionWith(valid);
    const fetch = okFetch({ access_token: 'should-not-be-used' });
    const manager = managerWith(fetch);

    await manager.list(TENANT, connectionId);

    expect(fetch).not.toHaveBeenCalled();
  });
});
