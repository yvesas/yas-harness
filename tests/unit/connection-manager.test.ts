// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The manager, end to end over the in-memory stores and vault. This is the
 * seam that proves the credential boundary: the agent-facing call returns a
 * resource, and the connector authenticates with a credential resolved from
 * the vault that the caller never handles.
 */

import { randomBytes } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ConnectionManager } from '../../src/connections/connection-manager.js';
import type { Connector, ConnectorContext } from '../../src/connections/connector.js';
import { ConnectorError } from '../../src/connections/connector.js';
import { ConnectorRegistry } from '../../src/connections/connector-registry.js';
import { VaultCredentialResolver } from '../../src/connections/credential-resolver.js';
import { CredentialVault } from '../../src/connections/credential-vault.js';
import { EnvelopeCipher } from '../../src/connections/envelope-cipher.js';
import {
  InMemoryConnectionStore,
  InMemoryCredentialStore,
  InMemoryTenantKeyStore,
} from '../../src/connections/in-memory-connection-store.js';
import { MemoryConnector } from '../../src/connections/memory-connector.js';

const TENANT = 'tenant-1';

let connectors: ConnectorRegistry;
let connections: InMemoryConnectionStore;
let vault: CredentialVault;
let manager: ConnectionManager;

beforeEach(() => {
  connectors = new ConnectorRegistry().register(new MemoryConnector({ id: 'drive' }));
  connections = new InMemoryConnectionStore();
  vault = new CredentialVault(
    new EnvelopeCipher(randomBytes(32)),
    new InMemoryTenantKeyStore(),
    new InMemoryCredentialStore(),
  );
  manager = new ConnectionManager(connectors, connections, new VaultCredentialResolver(vault));
});

async function activeConnection(connectorId = 'drive'): Promise<string> {
  const connection = await connections.create({ tenantId: TENANT, connectorId });
  await vault.store(TENANT, connection.id, { accessToken: 'secret-token' });
  return connection.id;
}

describe('ConnectionManager', () => {
  it('runs an operation and returns the resource', async () => {
    const connectionId = await activeConnection();

    const created = await manager.create(TENANT, connectionId, {
      title: 'Report',
      content: 'body',
    });
    const read = await manager.read(TENANT, connectionId, created.id);

    expect(read).toMatchObject({ title: 'Report', content: 'body' });
  });

  it('hands the connector the resolved credential and nothing else leaks', async () => {
    const seen: ConnectorContext[] = [];
    const spy: Connector = {
      id: 'spy',
      description: 'records its context',
      capabilities: ['read'],
      read: (context) => {
        seen.push(context);
        return Promise.resolve({
          id,
          type: 'doc',
          title: 't',
          content: null,
          mimeType: null,
          parentId: null,
          url: null,
          metadata: {},
          createdAt: null,
          updatedAt: null,
        });
      },
    };
    const id = 'x';
    connectors.register(spy);
    const spyConn = await connections.create({ tenantId: TENANT, connectorId: 'spy' });
    await vault.store(TENANT, spyConn.id, { accessToken: 'the-secret' });

    const result = await manager.read(TENANT, spyConn.id, id);

    // The connector got the decrypted credential...
    expect(seen[0]?.credential).toEqual({ accessToken: 'the-secret' });
    // ...and the caller got a resource, never the credential.
    expect(result).not.toHaveProperty('credential');
  });

  it('supports list, search, update and delete through the manager', async () => {
    const connectionId = await activeConnection();
    const doc = await manager.create(TENANT, connectionId, { title: 'Doc', content: 'find me' });

    await manager.update(TENANT, connectionId, doc.id, { content: 'edited' });
    expect((await manager.read(TENANT, connectionId, doc.id)).content).toBe('edited');

    expect((await manager.search(TENANT, connectionId, 'edited')).resources).toHaveLength(1);
    expect((await manager.list(TENANT, connectionId)).resources).toHaveLength(1);

    await manager.delete(TENANT, connectionId, doc.id);
    expect((await manager.list(TENANT, connectionId)).resources).toHaveLength(0);
  });

  it('refuses a connection that is not the tenant’s', async () => {
    const connectionId = await activeConnection();

    await expect(manager.read('other-tenant', connectionId, 'x')).rejects.toThrowError(
      /not found for tenant/,
    );
  });

  it('refuses a connection that is not active', async () => {
    const connectionId = await activeConnection();
    await connections.setStatus(TENANT, connectionId, 'revoked');

    await expect(manager.list(TENANT, connectionId)).rejects.toThrowError(/is revoked, not active/);
  });

  it('refuses when the connection has no stored credential', async () => {
    const connection = await connections.create({ tenantId: TENANT, connectorId: 'drive' });

    await expect(manager.list(TENANT, connection.id)).rejects.toThrowError(/no stored credential/);
  });

  it('refuses an operation the connector does not support', async () => {
    connectors.register(new MemoryConnector({ id: 'readonly', capabilities: ['list', 'read'] }));
    const connection = await connections.create({ tenantId: TENANT, connectorId: 'readonly' });
    await vault.store(TENANT, connection.id, { accessToken: 'x' });

    await expect(manager.create(TENANT, connection.id, { title: 'nope' })).rejects.toBeInstanceOf(
      ConnectorError,
    );
  });

  it('refuses when no connector is registered for the connection', async () => {
    const connection = await connections.create({ tenantId: TENANT, connectorId: 'unregistered' });
    await vault.store(TENANT, connection.id, { accessToken: 'x' });

    await expect(manager.list(TENANT, connection.id)).rejects.toThrowError(
      /no connector registered/,
    );
  });

  it('does not resolve a credential for a connection it will refuse', async () => {
    const connectionId = await activeConnection();
    await connections.setStatus(TENANT, connectionId, 'revoked');
    const resolve = vi.spyOn(vault, 'resolve');

    await expect(manager.list(TENANT, connectionId)).rejects.toThrow();

    // The status gate runs before the credential is ever decrypted.
    expect(resolve).not.toHaveBeenCalled();
  });
});
