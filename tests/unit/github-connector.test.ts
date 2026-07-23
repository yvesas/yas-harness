// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The GitHub connector, driven by a stub of the GitHub API. The translation is
 * the point: issues to resources with an `owner/repo#number` id, Markdown body
 * to content, the two list routes (a repo vs the user's issues), and dropping
 * pull requests that GitHub returns through the issues endpoint.
 */

import { describe, expect, it } from 'vitest';

import type { ConnectorContext } from '../../src/connections/connector.js';
import { ConnectorError, ResourceNotFoundError } from '../../src/connections/connector.js';
import { GitHubConnector } from '../../src/connections/connectors/github-connector.js';
import type { OAuthToken } from '../../src/connections/oauth.js';

const token: OAuthToken = {
  accessToken: 'gh-token',
  refreshToken: null,
  tokenType: 'Bearer',
  expiresAt: null,
  scope: null,
};
const ctx: ConnectorContext = { tenantId: 'tenant-1', connectionId: 'conn-1', credential: token };

const BASE = 'https://api.test';

interface Recorded {
  method: string;
  url: string;
  authorization: string | null;
  apiVersion: string | null;
  body: Record<string, unknown> | undefined;
}

function issue(
  number: number,
  title: string,
  body: string | null = null,
  extra: Record<string, unknown> = {},
) {
  return {
    number,
    title,
    body,
    state: 'open',
    html_url: `https://github.com/acme/widgets/issues/${number}`,
    user: { login: 'octocat' },
    created_at: '2026-07-01T00:00:00.000Z',
    updated_at: '2026-07-02T00:00:00.000Z',
    ...extra,
  };
}

function fakeGitHub(
  handler: (req: {
    method: string;
    path: string;
    query: URLSearchParams;
    body: Record<string, unknown> | undefined;
  }) => unknown,
) {
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
      apiVersion: headers.get('x-github-api-version'),
      body,
    });

    const result = handler({ method, path: u.pathname, query: u.searchParams, body });
    if (result === undefined) {
      return Promise.resolve(
        new Response(JSON.stringify({ message: 'Not Found' }), { status: 404 }),
      );
    }
    if (result === null) {
      return Promise.resolve(new Response('boom', { status: 500 }));
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
let connector: GitHubConnector;

function connect(handler: Parameters<typeof fakeGitHub>[0]) {
  const fake = fakeGitHub(handler);
  calls = fake.calls;
  connector = new GitHubConnector({ fetch: fake.fetch, baseUrl: BASE });
}

describe('GitHubConnector', () => {
  it('does not declare delete (GitHub has no issue delete)', () => {
    connect(() => []);
    expect(connector.capabilities).not.toContain('delete');
  });

  it('reads an issue, mapping the Markdown body and building an owner/repo#number id', async () => {
    connect(({ path }) =>
      path === '/repos/acme/widgets/issues/7'
        ? issue(7, 'Fix login', '## Steps\nreproduce it', {
            state: 'open',
            assignee: { login: 'yves' },
          })
        : undefined,
    );

    const resource = await connector.read(ctx, 'acme/widgets#7');

    expect(resource).toMatchObject({
      id: 'acme/widgets#7',
      type: 'issue',
      title: 'Fix login',
      content: '## Steps\nreproduce it',
      mimeType: 'text/markdown',
      parentId: 'acme/widgets',
      url: 'https://github.com/acme/widgets/issues/7',
      metadata: {
        number: 7,
        state: 'open',
        repo: 'acme/widgets',
        author: 'octocat',
        assignee: 'yves',
      },
    });
    expect(resource.updatedAt).toEqual(new Date('2026-07-02T00:00:00.000Z'));
  });

  it('authenticates with the token and sends the API version', async () => {
    connect(({ path }) => (path === '/repos/acme/widgets/issues/1' ? issue(1, 'x') : undefined));
    await connector.read(ctx, 'acme/widgets#1');

    expect(calls[0]?.authorization).toBe('Bearer gh-token');
    expect(calls[0]?.apiVersion).toBe('2022-11-28');
  });

  it('lists a repo’s issues when a parent is given', async () => {
    connect(({ path }) =>
      path === '/repos/acme/widgets/issues' ? [issue(1, 'One'), issue(2, 'Two')] : undefined,
    );

    const listed = await connector.list(ctx, { parentId: 'acme/widgets' });

    expect(listed.resources.map((r) => r.id)).toEqual(['acme/widgets#1', 'acme/widgets#2']);
  });

  it('lists the user’s assigned issues when no parent is given', async () => {
    connect(({ path }) => (path === '/issues' ? [issue(5, 'Assigned to me')] : undefined));

    const listed = await connector.list(ctx);

    expect(listed.resources[0]?.title).toBe('Assigned to me');
    expect(calls.some((c) => c.url.startsWith('/issues?'))).toBe(true);
  });

  it('drops pull requests returned through the issues endpoint', async () => {
    connect(({ path }) =>
      path === '/repos/acme/widgets/issues'
        ? [issue(1, 'Real issue'), issue(2, 'A PR', null, { pull_request: { url: 'x' } })]
        : undefined,
    );

    const listed = await connector.list(ctx, { parentId: 'acme/widgets' });

    expect(listed.resources.map((r) => r.title)).toEqual(['Real issue']);
  });

  it('paginates: a full page yields a next cursor, a short page ends it', async () => {
    connect(({ path, query }) => {
      if (path !== '/repos/acme/widgets/issues') return undefined;
      const page = Number(query.get('page'));
      return page === 1 ? [issue(1, 'a'), issue(2, 'b')] : [issue(3, 'c')];
    });

    const first = await connector.list(ctx, { parentId: 'acme/widgets', limit: 2 });
    expect(first.nextCursor).toBe('2');

    const second = await connector.list(ctx, { parentId: 'acme/widgets', limit: 2, cursor: '2' });
    expect(second.nextCursor).toBeNull();
  });

  it('searches issues, recovering the repo from each result’s url', async () => {
    connect(({ path, query }) => {
      if (path !== '/search/issues') return undefined;
      expect(query.get('q')).toBe('login type:issue');
      return { items: [issue(9, 'login broken')], total_count: 1 };
    });

    const found = await connector.search(ctx, 'login');

    expect(found.resources[0]).toMatchObject({ id: 'acme/widgets#9', parentId: 'acme/widgets' });
  });

  it('creates an issue in a repo', async () => {
    connect(({ method, path }) =>
      method === 'POST' && path === '/repos/acme/widgets/issues'
        ? issue(10, 'New bug', 'it breaks')
        : undefined,
    );

    const created = await connector.create(ctx, {
      title: 'New bug',
      content: 'it breaks',
      metadata: { repo: 'acme/widgets', labels: ['bug'] },
    });

    expect(created.id).toBe('acme/widgets#10');
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toEqual({ title: 'New bug', body: 'it breaks', labels: ['bug'] });
  });

  it('refuses to create an issue without a repo', async () => {
    connect(() => []);
    await expect(connector.create(ctx, { title: 'Homeless' })).rejects.toThrowError(
      /needs metadata\.repo/,
    );
  });

  it('edits an issue, and closes it via metadata.state', async () => {
    connect(({ method, path, body }) => {
      if (method === 'PATCH' && path === '/repos/acme/widgets/issues/3') {
        return issue(3, (body?.['title'] as string) ?? 'Old', 'body', {
          state: body?.['state'] ?? 'open',
        });
      }
      return undefined;
    });

    const updated = await connector.update(ctx, 'acme/widgets#3', {
      title: 'Renamed',
      metadata: { state: 'closed' },
    });

    expect(updated).toMatchObject({ title: 'Renamed', metadata: { state: 'closed' } });
    const patch = calls.find((c) => c.method === 'PATCH')!;
    expect(patch.body).toEqual({ title: 'Renamed', state: 'closed' });
  });

  it('rejects a malformed issue id', async () => {
    connect(() => []);
    await expect(connector.read(ctx, 'not-a-ref')).rejects.toThrowError(
      /expected "owner\/repo#number"/,
    );
  });

  it('maps a 404 to ResourceNotFoundError', async () => {
    connect(() => undefined);
    await expect(connector.read(ctx, 'acme/widgets#404')).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it('refuses a credential that is not an OAuth token', async () => {
    connect(() => []);
    const bad: ConnectorContext = { ...ctx, credential: { apiKey: 'nope' } };
    await expect(connector.list(bad, { parentId: 'acme/widgets' })).rejects.toBeInstanceOf(
      ConnectorError,
    );
  });
});
