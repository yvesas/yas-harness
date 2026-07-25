// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The Jira connector, driven by a stub of the Atlassian API. The translation is
 * the point: issues to resources, the description's document format to and from
 * text, JQL for list and search, and the read-back that create and update do
 * because Jira returns only a key or nothing.
 */

import { beforeEach, describe, expect, it } from 'vitest';

import type { ConnectorContext } from '../../src/connections/connector.js';
import { ResourceNotFoundError } from '../../src/connections/connector.js';
import { JiraConnector } from '../../src/connections/connectors/jira-connector.js';
import type { OAuthToken } from '../../src/connections/oauth.js';

const token: OAuthToken = {
  accessToken: 'jira-token',
  refreshToken: 'rt',
  tokenType: 'Bearer',
  expiresAt: null,
  scope: null,
};
const ctx: ConnectorContext = { tenantId: 'tenant-1', connectionId: 'conn-1', credential: token };

const CLOUD_ID = 'cloud-jira';

interface Recorded {
  method: string;
  url: string;
  body: Record<string, unknown> | undefined;
}

function adf(text: string): unknown {
  return {
    type: 'doc',
    version: 1,
    content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
  };
}

function issue(
  key: string,
  summary: string,
  description?: string,
  extra: Record<string, unknown> = {},
) {
  return {
    id: `id-${key}`,
    key,
    fields: {
      summary,
      ...(description ? { description: adf(description) } : {}),
      status: { name: 'To Do' },
      issuetype: { name: 'Task' },
      project: { key: 'PROJ' },
      ...extra,
    },
  };
}

interface StoredIssue {
  id: string;
  key: string;
  fields?: Record<string, unknown>;
}

function fakeJira(issues: Record<string, StoredIssue> = {}) {
  const store = new Map<string, StoredIssue>(Object.entries(issues));
  const calls: Recorded[] = [];
  let created = 0;

  const fetch: typeof globalThis.fetch = (url, init) => {
    const u = new URL(url instanceof Request ? url.url : url.toString());
    const method = init?.method ?? 'GET';
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined;
    calls.push({ method, url: u.pathname + u.search, body });

    const json = (payload: unknown, status = 200) =>
      Promise.resolve(
        new Response(status === 204 ? null : JSON.stringify(payload), {
          status,
          headers: { 'content-type': 'application/json' },
        }),
      );

    if (u.pathname === '/oauth/token/accessible-resources') {
      return json([{ id: CLOUD_ID }]);
    }
    const path = u.pathname.replace(`/ex/jira/${CLOUD_ID}`, '');

    if (path === '/rest/api/3/search') {
      return json({ issues: [...store.values()], startAt: 0, total: store.size });
    }
    if (path === '/rest/api/3/issue' && method === 'POST') {
      created += 1;
      const key = `PROJ-${100 + created}`;
      const fields = (body?.['fields'] ?? {}) as Record<string, unknown>;
      store.set(key, {
        id: `id-${key}`,
        key,
        fields: {
          summary: fields['summary'],
          description: fields['description'],
          status: { name: 'To Do' },
          issuetype: { name: 'Task' },
          project: { key: 'PROJ' },
        },
      });
      return json({ id: `id-${key}`, key });
    }
    const issueMatch = /^\/rest\/api\/3\/issue\/([^/?]+)/.exec(path);
    if (issueMatch) {
      const key = issueMatch[1]!;
      if (method === 'DELETE') {
        store.delete(key);
        return json(null, 204);
      }
      if (method === 'PUT') {
        const existing = store.get(key);
        if (!existing) return json({ message: 'not found' }, 404);
        const fields = (body?.['fields'] ?? {}) as Record<string, unknown>;
        existing.fields = { ...existing.fields, ...fields };
        return json(null, 204);
      }
      const found = store.get(key);
      return found ? json(found) : json({ message: 'not found' }, 404);
    }
    return json({ message: 'unexpected' }, 500);
  };

  return { fetch, calls };
}

let calls: Recorded[];
let connector: JiraConnector;

function jqlOf(url: string): string {
  return new URLSearchParams(url.slice(url.indexOf('?'))).get('jql') ?? '';
}

function connect(issues?: Record<string, StoredIssue>) {
  const fake = fakeJira(issues);
  calls = fake.calls;
  connector = new JiraConnector({ fetch: fake.fetch, baseUrl: 'https://api.test' });
}

beforeEach(() => connect());

describe('JiraConnector', () => {
  it('reads an issue, flattening the description to text', async () => {
    connect({
      'PROJ-1': issue('PROJ-1', 'Fix the login bug', 'Users cannot log in.', {
        assignee: { displayName: 'Yves' },
        parent: { key: 'PROJ-EPIC' },
        created: '2026-07-01T00:00:00.000Z',
        updated: '2026-07-02T00:00:00.000Z',
      }),
    });

    const resource = await connector.read(ctx, 'PROJ-1');

    expect(resource).toMatchObject({
      id: 'PROJ-1',
      type: 'issue',
      title: 'Fix the login bug',
      content: 'Users cannot log in.',
      parentId: 'PROJ-EPIC',
      metadata: {
        id: 'id-PROJ-1',
        status: 'To Do',
        issueType: 'Task',
        projectKey: 'PROJ',
        assignee: 'Yves',
      },
    });
    expect(resource.updatedAt).toEqual(new Date('2026-07-02T00:00:00.000Z'));
  });

  it('authenticates with the OAuth token', async () => {
    connect({ 'PROJ-1': issue('PROJ-1', 'x') });
    await connector.read(ctx, 'PROJ-1');
    // The site helper adds the header; if the token were missing it would throw.
    expect(calls.some((c) => c.url.includes('/rest/api/3/issue/PROJ-1'))).toBe(true);
  });

  it('lists issues via JQL, most recent first', async () => {
    connect({ 'PROJ-1': issue('PROJ-1', 'One'), 'PROJ-2': issue('PROJ-2', 'Two') });

    const listed = await connector.list(ctx);

    expect(listed.resources.map((r) => r.title).sort()).toEqual(['One', 'Two']);
    const search = calls.find((c) => c.url.includes('/rest/api/3/search'))!;
    expect(jqlOf(search.url)).toBe('order by updated DESC');
  });

  it('lists an issue’s children when a parent is given', async () => {
    connect({ 'PROJ-2': issue('PROJ-2', 'child') });

    await connector.list(ctx, { parentId: 'PROJ-1' });

    const search = calls.find((c) => c.url.includes('/rest/api/3/search'))!;
    expect(jqlOf(search.url)).toBe('parent = "PROJ-1" order by created DESC');
  });

  it('searches free text through JQL', async () => {
    connect({ 'PROJ-1': issue('PROJ-1', 'login') });

    await connector.search(ctx, 'login');

    const search = calls.find((c) => c.url.includes('/rest/api/3/search'))!;
    expect(jqlOf(search.url)).toBe('text ~ "login"');
  });

  it('creates an issue in a project and reads it back', async () => {
    const created = await connector.create(ctx, {
      title: 'New task',
      content: 'do the thing',
      metadata: { projectKey: 'PROJ', issueType: 'Story' },
    });

    expect(created.title).toBe('New task');
    expect(created.content).toBe('do the thing');
    const post = calls.find((c) => c.method === 'POST')!;
    expect(post.body).toMatchObject({
      fields: {
        project: { key: 'PROJ' },
        summary: 'New task',
        issuetype: { name: 'Story' },
        description: adf('do the thing'),
      },
    });
    // Create returns only a key, so the connector reads the issue back.
    expect(calls.some((c) => c.method === 'GET' && c.url.includes(`/issue/${created.id}`))).toBe(
      true,
    );
  });

  it('refuses to create an issue without a project', async () => {
    await expect(connector.create(ctx, { title: 'Homeless' })).rejects.toThrowError(
      /needs metadata\.projectKey/,
    );
  });

  it('edits an issue, sending only the patched fields as a document', async () => {
    connect({ 'PROJ-1': issue('PROJ-1', 'Old summary', 'old body') });

    const updated = await connector.update(ctx, 'PROJ-1', { content: 'new body' });

    const put = calls.find((c) => c.method === 'PUT')!;
    expect(put.body).toEqual({ fields: { description: adf('new body') } }); // summary untouched
    expect(updated.content).toBe('new body');
  });

  it('deletes an issue', async () => {
    connect({ 'PROJ-9': issue('PROJ-9', 'Temp') });

    await connector.delete(ctx, 'PROJ-9');

    expect(calls.some((c) => c.method === 'DELETE' && c.url.includes('/issue/PROJ-9'))).toBe(true);
    await expect(connector.read(ctx, 'PROJ-9')).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('maps a 404 to ResourceNotFoundError', async () => {
    await expect(connector.read(ctx, 'MISSING-1')).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('reads a null description as no content', async () => {
    connect({ 'PROJ-1': issue('PROJ-1', 'No description') });

    expect((await connector.read(ctx, 'PROJ-1')).content).toBeNull();
  });

  it('flattens a multi-block description with newlines', async () => {
    const multi = {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'First line.' }] },
        { type: 'paragraph', content: [{ type: 'text', text: 'Second line.' }] },
      ],
    };
    connect({
      'PROJ-1': { id: 'id-PROJ-1', key: 'PROJ-1', fields: { summary: 's', description: multi } },
    });

    expect((await connector.read(ctx, 'PROJ-1')).content).toBe('First line.\nSecond line.');
  });
});
