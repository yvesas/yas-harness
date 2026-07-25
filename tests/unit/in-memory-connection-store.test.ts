// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { ConnectionError } from '../../src/connections/connection-store.js';
import { InMemoryConnectionStore } from '../../src/connections/in-memory-connection-store.js';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

describe('InMemoryConnectionStore', () => {
  it('creates an active connection', async () => {
    const store = new InMemoryConnectionStore();

    const connection = await store.create({
      tenantId: TENANT_A,
      connectorId: 'google-drive',
      accountLabel: 'yves@yaslabs.com.br',
      scopes: ['drive.readonly'],
    });

    expect(connection).toMatchObject({
      connectorId: 'google-drive',
      status: 'active',
      accountLabel: 'yves@yaslabs.com.br',
      scopes: ['drive.readonly'],
    });
  });

  it('finds a connection by id', async () => {
    const store = new InMemoryConnectionStore();
    const created = await store.create({ tenantId: TENANT_A, connectorId: 'confluence' });

    expect(await store.find(TENANT_A, created.id)).toEqual(created);
  });

  it('does not reveal another tenant’s connection', async () => {
    const store = new InMemoryConnectionStore();
    const created = await store.create({ tenantId: TENANT_A, connectorId: 'confluence' });

    expect(await store.find(TENANT_B, created.id)).toBeNull();
  });

  it('lists a tenant’s connections, optionally by connector', async () => {
    const store = new InMemoryConnectionStore();
    await store.create({ tenantId: TENANT_A, connectorId: 'google-drive' });
    await store.create({ tenantId: TENANT_A, connectorId: 'notion' });
    await store.create({ tenantId: TENANT_B, connectorId: 'google-drive' });

    expect((await store.list(TENANT_A)).map((c) => c.connectorId)).toEqual([
      'google-drive',
      'notion',
    ]);
    expect((await store.list(TENANT_A, 'notion')).map((c) => c.connectorId)).toEqual(['notion']);
  });

  it('changes status and bumps updatedAt', async () => {
    const store = new InMemoryConnectionStore();
    const created = await store.create({ tenantId: TENANT_A, connectorId: 'notion' });

    const updated = await store.setStatus(TENANT_A, created.id, 'revoked');

    expect(updated.status).toBe('revoked');
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
  });

  it('will not change another tenant’s connection', async () => {
    const store = new InMemoryConnectionStore();
    const created = await store.create({ tenantId: TENANT_A, connectorId: 'notion' });

    await expect(store.setStatus(TENANT_B, created.id, 'revoked')).rejects.toBeInstanceOf(
      ConnectionError,
    );
  });

  it('reports whether a remove deleted anything', async () => {
    const store = new InMemoryConnectionStore();
    const created = await store.create({ tenantId: TENANT_A, connectorId: 'notion' });

    expect(await store.remove(TENANT_A, created.id)).toBe(true);
    expect(await store.remove(TENANT_A, created.id)).toBe(false);
  });
});
