// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The Notion connector, driven by a stub of the API. The translation is the
 * point: pages and databases to resources with `page:`/`database:` ids, the
 * title-typed property to a title, child blocks flattened to text, search over
 * both kinds, querying a database for its pages, creating a page under a
 * database (resolving its title property) and setting content as blocks, and
 * archive-as-delete.
 */

import { describe, expect, it } from 'vitest';

import type { ConnectorContext } from '../../src/connections/connector.js';
import { ConnectorError, ResourceNotFoundError } from '../../src/connections/connector.js';
import { NotionConnector } from '../../src/connections/connectors/notion-connector.js';
import type { OAuthToken } from '../../src/connections/oauth.js';

const token: OAuthToken = {
  accessToken: 'ntn-token',
  refreshToken: null,
  tokenType: 'Bearer',
  expiresAt: null,
  scope: null,
};
const ctx: ConnectorContext = { tenantId: 'tenant-1', connectionId: 'conn-1', credential: token };

const BASE = 'https://notion.test/v1';

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
}

function richText(text: string) {
  return [{ plain_text: text, text: { content: text } }];
}

function page(id: string, title = 'Untitled', extra: Record<string, unknown> = {}) {
  return {
    object: 'page',
    id,
    url: `https://notion.so/${id}`,
    archived: false,
    parent: { type: 'database_id', database_id: 'db1' },
    properties: { Name: { type: 'title', title: richText(title) } },
    created_time: '2026-07-01T00:00:00.000Z',
    last_edited_time: '2026-07-02T00:00:00.000Z',
    ...extra,
  };
}

function database(id: string, title = 'My database', extra: Record<string, unknown> = {}) {
  return {
    object: 'database',
    id,
    url: `https://notion.so/${id}`,
    archived: false,
    parent: { type: 'workspace', workspace: true },
    title: richText(title),
    properties: { Name: { type: 'title' } },
    created_time: '2026-07-01T00:00:00.000Z',
    last_edited_time: '2026-07-02T00:00:00.000Z',
    ...extra,
  };
}

function block(id: string, type: string, text: string, extra: Record<string, unknown> = {}) {
  return { id, type, [type]: { rich_text: richText(text), ...extra } };
}

function fakeNotion(handler: (req: Recorded) => unknown) {
  const calls: Recorded[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const u = new URL(url instanceof Request ? url.url : url.toString());
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined;
    calls.push({ method, path: u.pathname, query: u.searchParams, body });

    const result = handler({ method, path: u.pathname, query: u.searchParams, body });
    if (result === undefined) {
      return Promise.resolve(
        new Response(JSON.stringify({ object: 'error', message: 'not found' }), { status: 404 }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch, calls };
}

let calls: Recorded[];
let connector: NotionConnector;

function connect(handler: Parameters<typeof fakeNotion>[0]) {
  const fake = fakeNotion(handler);
  calls = fake.calls;
  connector = new NotionConnector({ fetch: fake.fetch, baseUrl: BASE });
}

describe('NotionConnector — read and list', () => {
  it('lists everything via search when there is no parent, mapping both kinds', async () => {
    connect(({ method, path }) =>
      method === 'POST' && path === '/v1/search'
        ? { results: [page('p1', 'A page'), database('d1', 'A database')], has_more: false }
        : undefined,
    );

    const listed = await connector.list(ctx);

    expect(listed.resources.map((r) => [r.id, r.type])).toEqual([
      ['page:p1', 'page'],
      ['database:d1', 'database'],
    ]);
    expect(listed.resources[0]).toMatchObject({ title: 'A page', parentId: 'database:db1' });
  });

  it('lists a database’s pages by querying it', async () => {
    connect(({ method, path }) =>
      method === 'POST' && path === '/v1/databases/db1/query'
        ? { results: [page('p1', 'Row 1')], has_more: true, next_cursor: 'CUR' }
        : undefined,
    );

    const listed = await connector.list(ctx, { parentId: 'database:db1' });

    expect(listed.resources[0]?.id).toBe('page:p1');
    expect(listed.nextCursor).toBe('CUR');
  });

  it('reads a page, flattening its blocks to text with light Markdown', async () => {
    connect(({ method, path }) => {
      if (method === 'GET' && path === '/v1/pages/p1') return page('p1', 'Design doc');
      if (method === 'GET' && path === '/v1/blocks/p1/children') {
        return {
          results: [
            block('b1', 'heading_1', 'Overview'),
            block('b2', 'paragraph', 'the intro'),
            block('b3', 'bulleted_list_item', 'first point'),
            block('b4', 'to_do', 'do it', { checked: true }),
          ],
          has_more: false,
        };
      }
      return undefined;
    });

    const resource = await connector.read(ctx, 'page:p1');

    expect(resource).toMatchObject({
      id: 'page:p1',
      type: 'page',
      title: 'Design doc',
      mimeType: 'text/markdown',
    });
    expect(resource.content).toBe('# Overview\nthe intro\n- first point\n- [x] do it');
  });

  it('reads a database', async () => {
    connect(({ method, path }) =>
      method === 'GET' && path === '/v1/databases/d1' ? database('d1', 'Tasks') : undefined,
    );

    const resource = await connector.read(ctx, 'database:d1');
    expect(resource).toMatchObject({ id: 'database:d1', type: 'database', title: 'Tasks' });
  });

  it('maps a 404 to ResourceNotFoundError', async () => {
    connect(() => undefined);

    await expect(connector.read(ctx, 'page:gone')).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('searches pages and databases', async () => {
    connect(({ method, path, body }) => {
      if (method === 'POST' && path === '/v1/search') {
        expect(body).toMatchObject({ query: 'roadmap' });
        return { results: [page('p9', 'Roadmap')], has_more: false };
      }
      return undefined;
    });

    const found = await connector.search(ctx, 'roadmap');
    expect(found.resources[0]?.id).toBe('page:p9');
  });

  it('rejects a malformed id', async () => {
    connect(() => ({}));

    await expect(connector.read(ctx, 'p1')).rejects.toThrowError(/expected "page:<uuid>"/);
  });
});

describe('NotionConnector — create', () => {
  it('creates a page in a database, resolving its title property', async () => {
    connect(({ method, path, body }) => {
      if (method === 'GET' && path === '/v1/databases/db1') return database('db1');
      if (method === 'POST' && path === '/v1/pages') {
        expect(body).toMatchObject({
          parent: { database_id: 'db1' },
          properties: { Name: { title: [{ text: { content: 'New task' } }] } },
        });
        expect(Array.isArray(body?.['children'])).toBe(true);
        return page('new1', 'New task');
      }
      return undefined;
    });

    const created = await connector.create(ctx, {
      title: 'New task',
      content: 'the body',
      parentId: 'database:db1',
    });

    expect(created.id).toBe('page:new1');
    expect(created.content).toBe('the body');
  });

  it('creates a page under a page parent, keyed by "title"', async () => {
    connect(({ method, path, body }) => {
      if (method === 'POST' && path === '/v1/pages') {
        expect(body).toMatchObject({
          parent: { page_id: 'par1' },
          properties: { title: { title: [{ text: { content: 'Child' } }] } },
        });
        return page('child1', 'Child');
      }
      return undefined;
    });

    const created = await connector.create(ctx, { title: 'Child', parentId: 'page:par1' });
    expect(created.id).toBe('page:child1');
  });

  it('needs a parent to create a page', async () => {
    connect(() => ({}));

    await expect(connector.create(ctx, { title: 'Orphan' })).rejects.toThrowError(
      /needs a parentId/,
    );
  });
});

describe('NotionConnector — update and delete', () => {
  it('updates a page title, patching the title-typed property', async () => {
    connect(({ method, path, body }) => {
      if (method === 'GET' && path === '/v1/pages/p1') return page('p1', 'Renamed');
      if (method === 'PATCH' && path === '/v1/pages/p1') {
        expect(body).toMatchObject({
          properties: { Name: { title: [{ text: { content: 'Renamed' } }] } },
        });
        return page('p1', 'Renamed');
      }
      if (method === 'GET' && path === '/v1/blocks/p1/children')
        return { results: [], has_more: false };
      return undefined;
    });

    const updated = await connector.update(ctx, 'page:p1', { title: 'Renamed' });

    expect(updated.title).toBe('Renamed');
  });

  it('sets a page’s content by replacing its blocks', async () => {
    let replaced = false;
    connect(({ method, path, body }) => {
      if (method === 'GET' && path === '/v1/pages/p1') return page('p1', 'Doc');
      if (method === 'GET' && path === '/v1/blocks/p1/children') {
        return replaced
          ? { results: [block('bn', 'paragraph', 'new body')], has_more: false }
          : { results: [block('b1', 'paragraph', 'old body')], has_more: false };
      }
      if (method === 'DELETE' && path === '/v1/blocks/b1') return {};
      if (method === 'PATCH' && path === '/v1/blocks/p1/children') {
        expect(body?.['children']).toEqual([
          {
            object: 'block',
            type: 'paragraph',
            paragraph: { rich_text: [{ text: { content: 'new body' } }] },
          },
        ]);
        replaced = true;
        return {};
      }
      return undefined;
    });

    const updated = await connector.update(ctx, 'page:p1', { content: 'new body' });

    expect(updated.content).toBe('new body');
    // Deleted the old block before appending the new one.
    const ops = calls.map((c) => `${c.method} ${c.path}`);
    expect(ops).toContain('DELETE /v1/blocks/b1');
    expect(ops.indexOf('DELETE /v1/blocks/b1')).toBeLessThan(
      ops.indexOf('PATCH /v1/blocks/p1/children'),
    );
  });

  it('updates a database title and description', async () => {
    connect(({ method, path, body }) => {
      if (method === 'PATCH' && path === '/v1/databases/d1') {
        expect(body).toMatchObject({
          title: [{ text: { content: 'Renamed DB' } }],
          description: [{ text: { content: 'now described' } }],
        });
        return database('d1', 'Renamed DB');
      }
      return undefined;
    });

    const updated = await connector.update(ctx, 'database:d1', {
      title: 'Renamed DB',
      content: 'now described',
    });
    expect(updated.title).toBe('Renamed DB');
  });

  it('archives a page on delete', async () => {
    connect(({ method, path, body }) => {
      if (method === 'PATCH' && path === '/v1/pages/p1') {
        expect(body).toEqual({ archived: true });
        return page('p1');
      }
      return undefined;
    });

    await connector.delete(ctx, 'page:p1');
    expect(calls.some((c) => c.method === 'PATCH' && c.path === '/v1/pages/p1')).toBe(true);
  });

  it('archives a database on delete', async () => {
    connect(({ method, path, body }) => {
      if (method === 'PATCH' && path === '/v1/databases/d1') {
        expect(body).toEqual({ archived: true });
        return database('d1');
      }
      return undefined;
    });

    await connector.delete(ctx, 'database:d1');
    expect(calls.some((c) => c.path === '/v1/databases/d1')).toBe(true);
  });

  it('fails when the credential is not an OAuth token', async () => {
    connect(() => ({}));
    const bad: ConnectorContext = { ...ctx, credential: { apiKey: 'nope' } };

    await expect(connector.read(bad, 'page:p1')).rejects.toBeInstanceOf(ConnectorError);
  });
});
