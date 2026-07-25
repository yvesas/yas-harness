// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The Confluence connector, driven by a stub that plays the Atlassian API.
 * What is tested is the translation: pages to resources, storage body to
 * content, cursor pagination, the read-then-write version rule, and that the
 * OAuth token authenticates every call.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { ConnectorContext } from '../../src/connections/connector.js';
import { ResourceNotFoundError } from '../../src/connections/connector.js';
import { ConfluenceConnector } from '../../src/connections/connectors/confluence-connector.js';
import type { OAuthToken } from '../../src/connections/oauth.js';

const token: OAuthToken = {
  accessToken: 'atlassian-access-token',
  refreshToken: 'rt',
  tokenType: 'Bearer',
  expiresAt: null,
  scope: null,
};

const ctx: ConnectorContext = { tenantId: 'tenant-1', connectionId: 'conn-1', credential: token };

const CLOUD_ID = 'cloud-abc';
const BASE = 'https://api.test';

interface Recorded {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

/**
 * A tiny fake of the Atlassian API: it records every request and answers a few
 * routes. accessible-resources returns one site; pages routes behave enough to
 * exercise the translation.
 */
function fakeAtlassian(pages: Record<string, Record<string, unknown>> = {}) {
  const store = new Map(Object.entries(pages));
  const calls: Recorded[] = [];

  const fetch: typeof globalThis.fetch = (url, init) => {
    const u = new URL(url instanceof Request ? url.url : url.toString());
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined;
    const headers = new Headers(init?.headers);
    calls.push({
      method,
      url: u.pathname + u.search,
      authorization: headers.get('authorization'),
      body,
    });

    const json = (payload: unknown, status = 200) =>
      Promise.resolve(
        new Response(status === 204 ? null : JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );

    if (u.pathname === '/oauth/token/accessible-resources') {
      return json([{ id: CLOUD_ID, name: 'site', url: 'https://site.atlassian.net' }]);
    }

    const prefix = `/ex/confluence/${CLOUD_ID}`;
    const path = u.pathname.startsWith(prefix) ? u.pathname.slice(prefix.length) : u.pathname;

    // GET /wiki/api/v2/pages/{id}/children  (list under a parent)
    if (/^\/wiki\/api\/v2\/pages\/[^/]+\/children$/.test(path)) {
      return json({ results: [...store.entries()].map(([id, p]) => ({ ...p, id })), _links: {} });
    }

    // GET /wiki/api/v2/pages/{id}
    const pageMatch = /^\/wiki\/api\/v2\/pages\/([^/]+)$/.exec(path);
    if (pageMatch) {
      const id = pageMatch[1]!;
      if (method === 'DELETE') {
        store.delete(id);
        return json(null, 204);
      }
      if (method === 'PUT') {
        store.set(id, { ...store.get(id), ...body });
        return json({ ...store.get(id), id });
      }
      const page = store.get(id);
      return page ? json({ ...page, id }) : json({ message: 'not found' }, 404);
    }

    // POST /wiki/api/v2/pages  (create)
    if (path === '/wiki/api/v2/pages' && method === 'POST') {
      const id = `new-${store.size + 1}`;
      const created = { ...body, id, version: { number: 1 } };
      store.set(id, created);
      return json(created);
    }

    // GET /wiki/api/v2/pages  (list)
    if (
      method === 'GET' &&
      (path.startsWith('/wiki/api/v2/pages?') || path === '/wiki/api/v2/pages')
    ) {
      return json({
        results: [...store.entries()].map(([id, p]) => ({ ...p, id })),
        _links: { next: '/wiki/api/v2/pages?cursor=NEXT&limit=25' },
      });
    }

    // GET /wiki/rest/api/content/search
    if (path.startsWith('/wiki/rest/api/content/search')) {
      return json({
        results: [{ id: '100', title: 'Found', status: 'current', _links: { webui: '/x' } }],
        _links: {},
      });
    }

    return json({ message: 'unexpected route' }, 500);
  };

  return { fetch, calls };
}

let calls: Recorded[];
let connector: ConfluenceConnector;

function connect(pages?: Record<string, Record<string, unknown>>) {
  const fake = fakeAtlassian(pages);
  calls = fake.calls;
  connector = new ConfluenceConnector({ fetch: fake.fetch, baseUrl: BASE });
}

beforeEach(() => connect());

describe('ConfluenceConnector', () => {
  it('reads a page, mapping storage body to content', async () => {
    connect({
      '42': {
        title: 'Runbook',
        spaceId: 'space-1',
        parentId: '7',
        status: 'current',
        body: { storage: { value: '<p>steps</p>' } },
        version: { number: 3, createdAt: '2026-07-01T00:00:00.000Z' },
        _links: { webui: '/spaces/S/pages/42' },
      },
    });

    const page = await connector.read(ctx, '42');

    expect(page).toMatchObject({
      id: '42',
      type: 'page',
      title: 'Runbook',
      content: '<p>steps</p>',
      mimeType: 'text/html',
      parentId: '7',
      url: '/spaces/S/pages/42',
      metadata: { spaceId: 'space-1', status: 'current', version: 3 },
    });
    expect(page.updatedAt).toEqual(new Date('2026-07-01T00:00:00.000Z'));
  });

  it('authenticates every call with the OAuth token', async () => {
    connect({ '1': { title: 'x', body: { storage: { value: '' } } } });

    await connector.read(ctx, '1');

    expect(calls.every((c) => c.authorization === `Bearer ${token.accessToken}`)).toBe(true);
  });

  it('discovers the cloudId once and reuses it', async () => {
    connect({ '1': { title: 'a' }, '2': { title: 'b' } });

    await connector.read(ctx, '1');
    await connector.read(ctx, '2');

    // accessible-resources hit once; both reads go to the same cloud id.
    const discovery = calls.filter((c) => c.url === '/oauth/token/accessible-resources');
    expect(discovery).toHaveLength(1);
    expect(calls.filter((c) => c.url.includes(`/ex/confluence/${CLOUD_ID}/`)).length).toBe(2);
  });

  it('lists pages and surfaces the pagination cursor', async () => {
    connect({ '1': { title: 'One' }, '2': { title: 'Two' } });

    const listed = await connector.list(ctx, { limit: 25 });

    expect(listed.resources.map((r) => r.title).sort()).toEqual(['One', 'Two']);
    expect(listed.nextCursor).toBe('NEXT');
  });

  it('lists a page’s children when a parent is given', async () => {
    connect({ '1': { title: 'child' } });

    await connector.list(ctx, { parentId: '99' });

    expect(calls.some((c) => c.url.includes('/pages/99/children'))).toBe(true);
  });

  it('searches through CQL and maps the results', async () => {
    const found = await connector.search(ctx, 'incident');

    const searchCall = calls.find((c) => c.url.includes('/wiki/rest/api/content/search'))!;
    // The cql param carries the query; URLSearchParams encodes the space as +.
    const cql = new URLSearchParams(searchCall.url.slice(searchCall.url.indexOf('?'))).get('cql');
    expect(cql).toBe('text ~ "incident"');
    expect(found.resources[0]).toMatchObject({ id: '100', title: 'Found' });
  });

  it('creates a page in a space', async () => {
    const created = await connector.create(ctx, {
      title: 'New runbook',
      content: '<p>draft</p>',
      metadata: { spaceId: 'space-9' },
    });

    expect(created.title).toBe('New runbook');
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({
      spaceId: 'space-9',
      title: 'New runbook',
      body: { representation: 'storage', value: '<p>draft</p>' },
    });
  });

  it('refuses to create a page without a space', async () => {
    await expect(connector.create(ctx, { title: 'Homeless' })).rejects.toThrowError(
      /needs metadata\.spaceId/,
    );
  });

  it('edits a page, bumping the version it read', async () => {
    connect({
      '5': {
        title: 'Old title',
        status: 'current',
        body: { storage: { value: '<p>v1</p>' } },
        version: { number: 4 },
      },
    });

    const updated = await connector.update(ctx, '5', { content: '<p>v2</p>' });

    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toMatchObject({
      id: '5',
      title: 'Old title', // untouched: only content was patched
      body: { representation: 'storage', value: '<p>v2</p>' },
      version: { number: 5 }, // read 4, wrote 5
    });
    expect(updated.id).toBe('5');
  });

  it('deletes a page', async () => {
    connect({ '9': { title: 'Temp', body: { storage: { value: '' } } } });

    await connector.delete(ctx, '9');

    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/pages/9'))).toBe(true);
    await expect(connector.read(ctx, '9')).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('maps a 404 to ResourceNotFoundError', async () => {
    await expect(connector.read(ctx, 'missing')).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('refuses a credential that is not an OAuth token', async () => {
    const bad: ConnectorContext = { ...ctx, credential: { apiKey: 'nope' } };

    await expect(connector.read(bad, '1')).rejects.toThrowError(/no OAuth token/);
  });
});
