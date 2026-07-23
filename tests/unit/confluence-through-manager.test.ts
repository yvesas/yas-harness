// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The B81 case, end to end: register the real Confluence connector, connect an
 * account, and read and edit a page through the connection manager — with the
 * OAuth token resolved from the vault, never seen by the caller. This is the
 * proof that the generic layer carries a real source without any special case.
 */

import { randomBytes } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { ConnectionManager } from '../../src/connections/connection-manager.js';
import { ConnectorRegistry } from '../../src/connections/connector-registry.js';
import { ConfluenceConnector } from '../../src/connections/connectors/confluence-connector.js';
import { VaultCredentialResolver } from '../../src/connections/credential-resolver.js';
import { CredentialVault } from '../../src/connections/credential-vault.js';
import { EnvelopeCipher } from '../../src/connections/envelope-cipher.js';
import {
  InMemoryConnectionStore,
  InMemoryCredentialStore,
  InMemoryTenantKeyStore,
} from '../../src/connections/in-memory-connection-store.js';
import type { OAuthToken } from '../../src/connections/oauth.js';

const TENANT = 'tenant-1';
const CLOUD_ID = 'cloud-xyz';

const token: OAuthToken = {
  accessToken: 'confluence-token',
  refreshToken: 'rt',
  tokenType: 'Bearer',
  expiresAt: null,
  scope: null,
};

function fakeAtlassian() {
  const pages = new Map<string, Record<string, unknown>>([
    [
      '10',
      {
        title: 'B81 planning',
        spaceId: 'space-1',
        status: 'current',
        body: { storage: { value: '<p>original</p>' } },
        version: { number: 1 },
      },
    ],
  ]);

  const fetch: typeof globalThis.fetch = (url, init) => {
    const u = new URL(url instanceof Request ? url.url : url.toString());
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined;
    const json = (payload: unknown) =>
      Promise.resolve(
        new Response(JSON.stringify(payload), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
      );

    if (u.pathname === '/oauth/token/accessible-resources') {
      return json([{ id: CLOUD_ID, name: 'b81', url: 'https://b81.atlassian.net' }]);
    }
    const path = u.pathname.replace(`/ex/confluence/${CLOUD_ID}`, '');
    const match = /^\/wiki\/api\/v2\/pages\/([^/?]+)/.exec(path);
    const id = match?.[1];
    if (id && method === 'PUT' && body) {
      // Confluence takes { body: { representation, value } } on write but
      // returns { body: { storage: { value } } } on read — translate.
      const input = body['body'] as { value?: string } | undefined;
      pages.set(id, {
        ...pages.get(id),
        title: body['title'],
        version: body['version'],
        body: { storage: { value: input?.value ?? '' } },
      });
      return json({ ...pages.get(id), id });
    }
    if (id) {
      return json({ ...pages.get(id), id });
    }
    return Promise.resolve(new Response('nope', { status: 500 }));
  };

  return fetch;
}

let manager: ConnectionManager;
let connections: InMemoryConnectionStore;
let vault: CredentialVault;

beforeEach(() => {
  connections = new InMemoryConnectionStore();
  vault = new CredentialVault(
    new EnvelopeCipher(randomBytes(32)),
    new InMemoryTenantKeyStore(),
    new InMemoryCredentialStore(),
  );
  const connectors = new ConnectorRegistry().register(
    new ConfluenceConnector({ fetch: fakeAtlassian() }),
  );
  manager = new ConnectionManager(connectors, connections, new VaultCredentialResolver(vault));
});

async function connectConfluence(): Promise<string> {
  const connection = await connections.create({
    tenantId: TENANT,
    connectorId: 'confluence',
    accountLabel: 'B81 space',
    scopes: ['read:confluence-content.all', 'write:confluence-content'],
  });
  await vault.store(TENANT, connection.id, token);
  return connection.id;
}

describe('Confluence through the connection manager (B81)', () => {
  it('reads a page without the caller ever handling the token', async () => {
    const connectionId = await connectConfluence();

    const page = await manager.read(TENANT, connectionId, '10');

    expect(page).toMatchObject({ title: 'B81 planning', content: '<p>original</p>', type: 'page' });
  });

  it('edits a page back to the source', async () => {
    const connectionId = await connectConfluence();

    const updated = await manager.update(TENANT, connectionId, '10', {
      content: '<p>revised for the sprint</p>',
    });

    expect(updated.id).toBe('10');
    // Re-reading reflects the write that went back to Confluence.
    const reread = await manager.read(TENANT, connectionId, '10');
    expect(reread.content).toBe('<p>revised for the sprint</p>');
  });

  it('refuses when the connection is not the tenant’s', async () => {
    const connectionId = await connectConfluence();

    await expect(manager.read('someone-else', connectionId, '10')).rejects.toThrow();
  });
});
