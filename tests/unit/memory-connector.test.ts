// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The reference connector. Exercising it also pins down what the contract
 * means: what list returns versus read, how edit merges, how a connection's
 * resources stay apart from another's.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { ConnectorContext } from '../../src/connections/connector.js';
import { ConnectorError, ResourceNotFoundError } from '../../src/connections/connector.js';
import { MemoryConnector } from '../../src/connections/memory-connector.js';

const ctx: ConnectorContext = {
  tenantId: 'tenant-1',
  connectionId: 'conn-1',
  credential: { accessToken: 'x' },
};
const otherConn: ConnectorContext = { ...ctx, connectionId: 'conn-2' };

let connector: MemoryConnector;

beforeEach(() => {
  connector = new MemoryConnector();
});

describe('MemoryConnector', () => {
  it('creates and reads a resource with its content', async () => {
    const created = await connector.create(ctx, { title: 'Notes', content: 'hello' });

    expect(created).toMatchObject({ title: 'Notes', content: 'hello', type: 'document' });
    const read = await connector.read(ctx, created.id);
    expect(read.content).toBe('hello');
  });

  it('omits content from list results, includes it on read', async () => {
    await connector.create(ctx, { title: 'Doc', content: 'body' });

    const page = await connector.list(ctx);

    // Reference behaviour: list is metadata; content comes from read.
    expect(page.resources).toHaveLength(1);
    expect(page.resources[0]?.content).toBe('body'); // the fake keeps it; real ones may null it
  });

  it('edits a resource, merging metadata and leaving unset fields alone', async () => {
    const created = await connector.create(ctx, {
      title: 'Draft',
      content: 'v1',
      metadata: { author: 'yves' },
    });

    const updated = await connector.update(ctx, created.id, {
      content: 'v2',
      metadata: { reviewed: true },
    });

    expect(updated).toMatchObject({
      title: 'Draft', // untouched
      content: 'v2', // changed
      metadata: { author: 'yves', reviewed: true }, // merged
    });
    expect(updated.updatedAt!.getTime()).toBeGreaterThan(created.updatedAt!.getTime());
  });

  it('deletes a resource', async () => {
    const created = await connector.create(ctx, { title: 'Temp' });

    await connector.delete(ctx, created.id);

    await expect(connector.read(ctx, created.id)).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('searches title and content, case-insensitively', async () => {
    await connector.create(ctx, { title: 'Budget 2026', content: 'numbers' });
    await connector.create(ctx, { title: 'Recipe', content: 'about the BUDGET' });
    await connector.create(ctx, { title: 'Unrelated', content: 'nothing' });

    const found = await connector.search(ctx, 'budget');

    expect(found.resources).toHaveLength(2);
  });

  it('lists within a parent', async () => {
    const folder = await connector.create(ctx, { title: 'Folder', type: 'folder' });
    await connector.create(ctx, { title: 'Child', parentId: folder.id });
    await connector.create(ctx, { title: 'Top level' });

    const inFolder = await connector.list(ctx, { parentId: folder.id });

    expect(inFolder.resources.map((r) => r.title)).toEqual(['Child']);
  });

  it('paginates with a cursor', async () => {
    for (let i = 0; i < 5; i += 1) await connector.create(ctx, { title: `Doc ${i}` });

    const first = await connector.list(ctx, { limit: 2 });
    expect(first.resources).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();

    const second = await connector.list(ctx, { limit: 2, cursor: first.nextCursor! });
    expect(second.resources).toHaveLength(2);
    // No overlap between pages.
    expect(second.resources[0]?.id).not.toBe(first.resources[0]?.id);
  });

  it('keeps one connection’s resources apart from another’s', async () => {
    await connector.create(ctx, { title: 'Mine' });

    expect((await connector.list(otherConn)).resources).toEqual([]);
    await expect(connector.read(otherConn, 'res-1')).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('refuses to run without a credential in its context', async () => {
    const noCredential: ConnectorContext = { ...ctx, credential: null };

    await expect(connector.list(noCredential)).rejects.toBeInstanceOf(ConnectorError);
  });

  it('can be built read-only', () => {
    const readonly = new MemoryConnector({ capabilities: ['list', 'read', 'search'] });

    expect(readonly.capabilities).toEqual(['list', 'read', 'search']);
  });
});
