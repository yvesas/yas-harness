// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The Microsoft Teams connector, driven by a stub of the Graph API. The
 * translation is the point: teams, channels and messages to resources with
 * `team:` / `channel:<teamId>:<channelId>` / `message:<teamId>:<channelId>:<id>`
 * ids — including a channel id that itself contains colons and an @ — browsing
 * down the hierarchy, the `{ value, @odata.nextLink }` paging, posting a
 * message, and the read-and-post-only capability set.
 */

import { describe, expect, it } from 'vitest';

import type { ConnectorContext } from '../../src/connections/connector.js';
import { ConnectorError, ResourceNotFoundError } from '../../src/connections/connector.js';
import { TeamsConnector } from '../../src/connections/connectors/teams-connector.js';
import type { OAuthToken } from '../../src/connections/oauth.js';

const token: OAuthToken = {
  accessToken: 'graph-token',
  refreshToken: null,
  tokenType: 'Bearer',
  expiresAt: null,
  scope: null,
};
const ctx: ConnectorContext = { tenantId: 'tenant-1', connectionId: 'conn-1', credential: token };

const BASE = 'https://graph.test/v1.0';
// A real Graph channel id: colons and an @, which the id scheme must survive.
const CHAN = '19:abc@thread.tacv2';

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
}

function team(id: string, name: string) {
  return { id, displayName: name, description: 'a team' };
}

function channel(id: string, name: string) {
  return {
    id,
    displayName: name,
    description: 'a channel',
    webUrl: `https://teams.microsoft.com/${id}`,
  };
}

function message(id: string, content: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    subject: null,
    body: { content, contentType: 'text' },
    from: { user: { displayName: 'Ana' } },
    webUrl: `https://teams.microsoft.com/msg/${id}`,
    createdDateTime: '2026-08-01T10:00:00Z',
    lastModifiedDateTime: '2026-08-01T10:05:00Z',
    ...extra,
  };
}

function fakeGraph(handler: (req: Recorded) => unknown) {
  const calls: Recorded[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const u = new URL(url instanceof Request ? url.url : url.toString());
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined;
    calls.push({ method: init?.method ?? 'GET', path: u.pathname, query: u.searchParams, body });

    const result = handler(calls[calls.length - 1]!);
    if (result === undefined) {
      return Promise.resolve(
        new Response(JSON.stringify({ error: { code: 'NotFound' } }), { status: 404 }),
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

let connector: TeamsConnector;

function connect(handler: Parameters<typeof fakeGraph>[0]) {
  const fake = fakeGraph(handler);
  connector = new TeamsConnector({ fetch: fake.fetch, baseUrl: BASE });
}

describe('TeamsConnector — hierarchy', () => {
  it('declares list, read and create only (no edit/delete for channel messages)', () => {
    connect(() => ({ value: [] }));
    expect(connector.capabilities).toEqual(['list', 'read', 'create']);
  });

  it('lists joined teams, carrying the skiptoken from the next link', async () => {
    connect(({ path }) =>
      path === '/v1.0/me/joinedTeams'
        ? {
            value: [team('T1', 'Engineering'), team('T2', 'Design')],
            '@odata.nextLink': 'https://graph.test/v1.0/me/joinedTeams?$skiptoken=TOK',
          }
        : undefined,
    );

    const listed = await connector.list(ctx);

    expect(listed.resources.map((r) => r.id)).toEqual(['team:T1', 'team:T2']);
    expect(listed.resources[0]).toMatchObject({ type: 'team', title: 'Engineering' });
    expect(listed.nextCursor).toBe('TOK');
  });

  it('lists a team’s channels, parenting them to the team', async () => {
    connect(({ path }) =>
      path === '/v1.0/teams/T1/channels' ? { value: [channel(CHAN, 'General')] } : undefined,
    );

    const listed = await connector.list(ctx, { type: 'channel', parentId: 'team:T1' });

    expect(listed.resources[0]).toMatchObject({
      id: `channel:T1:${CHAN}`,
      type: 'channel',
      title: 'General',
      parentId: 'team:T1',
      metadata: { teamId: 'T1', channelId: CHAN },
    });
  });

  it('needs a parent to list channels', async () => {
    connect(() => undefined);

    await expect(connector.list(ctx, { type: 'channel' })).rejects.toThrowError(/needs a parent/);
  });

  it('lists a channel’s messages, parenting them and preserving the colon-y channel id', async () => {
    connect(({ path }) =>
      path === `/v1.0/teams/T1/channels/${CHAN}/messages`
        ? { value: [message('1616990032035', 'hello team')] }
        : undefined,
    );

    const listed = await connector.list(ctx, { type: 'message', parentId: `channel:T1:${CHAN}` });

    expect(listed.resources[0]).toMatchObject({
      id: `message:T1:${CHAN}:1616990032035`,
      type: 'message',
      title: 'hello team',
      content: 'hello team',
      parentId: `channel:T1:${CHAN}`,
      metadata: { teamId: 'T1', channelId: CHAN, messageId: '1616990032035', author: 'Ana' },
    });
  });

  it('needs a channel parent to list messages', async () => {
    connect(() => undefined);

    await expect(
      connector.list(ctx, { type: 'message', parentId: 'team:T1' }),
    ).rejects.toThrowError(/needs a channel parent/);
  });
});

describe('TeamsConnector — read', () => {
  it('reads a team, a channel and a message down the path', async () => {
    connect(({ path }) => {
      if (path === '/v1.0/teams/T1') return team('T1', 'Engineering');
      if (path === `/v1.0/teams/T1/channels/${CHAN}`) return channel(CHAN, 'General');
      if (path === `/v1.0/teams/T1/channels/${CHAN}/messages/1616990032035`) {
        return message('1616990032035', '<p>hi</p>', {
          body: { content: '<p>hi</p>', contentType: 'html' },
        });
      }
      return undefined;
    });

    expect((await connector.read(ctx, 'team:T1')).type).toBe('team');
    expect((await connector.read(ctx, `channel:T1:${CHAN}`)).parentId).toBe('team:T1');

    const msg = await connector.read(ctx, `message:T1:${CHAN}:1616990032035`);
    // An HTML body is not parsed for a title; subject-less → falls back to the id.
    expect(msg).toMatchObject({
      type: 'message',
      mimeType: 'text/html',
      title: 'message 1616990032035',
    });
    expect(msg.content).toBe('<p>hi</p>');
  });

  it('uses a message subject as the title when present', async () => {
    connect(({ path }) =>
      path === `/v1.0/teams/T1/channels/${CHAN}/messages/m1`
        ? message('m1', 'body text', { subject: 'Release notes' })
        : undefined,
    );

    const msg = await connector.read(ctx, `message:T1:${CHAN}:m1`);
    expect(msg.title).toBe('Release notes');
  });

  it('maps a 404 to ResourceNotFoundError', async () => {
    connect(() => undefined);

    await expect(connector.read(ctx, 'team:gone')).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('rejects a malformed id', async () => {
    connect(() => ({}));

    await expect(connector.read(ctx, 'T1')).rejects.toThrowError(/expected "team:<id>"/);
  });
});

describe('TeamsConnector — post', () => {
  it('posts a message to a channel, parenting it', async () => {
    connect(({ method, path, body }) => {
      if (method === 'POST' && path === `/v1.0/teams/T1/channels/${CHAN}/messages`) {
        expect(body).toMatchObject({ body: { content: 'ship it', contentType: 'text' } });
        return message('newId', 'ship it');
      }
      return undefined;
    });

    const created = await connector.create(ctx, {
      type: 'message',
      title: 'ignored',
      content: 'ship it',
      parentId: `channel:T1:${CHAN}`,
    });

    expect(created.id).toBe(`message:T1:${CHAN}:newId`);
    expect(created.parentId).toBe(`channel:T1:${CHAN}`);
  });

  it('needs a channel parent to post', async () => {
    connect(() => ({}));

    await expect(
      connector.create(ctx, { type: 'message', title: 'hi', parentId: 'team:T1' }),
    ).rejects.toThrowError(/needs a channel parent/);
  });

  it('refuses to create a team or a channel', async () => {
    connect(() => ({}));

    await expect(
      connector.create(ctx, { type: 'channel', title: 'x', parentId: 'team:T1' }),
    ).rejects.toThrowError(/only a message/);
  });

  it('fails when the credential is not an OAuth token', async () => {
    connect(() => ({}));
    const bad: ConnectorContext = { ...ctx, credential: { key: 'x' } };

    await expect(connector.read(bad, 'team:T1')).rejects.toBeInstanceOf(ConnectorError);
  });
});
