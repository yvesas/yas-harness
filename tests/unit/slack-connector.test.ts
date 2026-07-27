// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The Slack connector, driven by a stub of the Web API. The translation is the
 * point: channels and messages to resources with `channel:`/`message:` ids, a
 * message parented to its channel, listing a channel's history, the `ok:false`
 * → not-found / error mapping, search over messages, and posting/editing/
 * deleting a message (with channels rejected for writes).
 */

import { describe, expect, it } from 'vitest';

import type { ConnectorContext } from '../../src/connections/connector.js';
import { ConnectorError, ResourceNotFoundError } from '../../src/connections/connector.js';
import { SlackConnector } from '../../src/connections/connectors/slack-connector.js';
import type { OAuthToken } from '../../src/connections/oauth.js';

const token: OAuthToken = {
  accessToken: 'xoxb-token',
  refreshToken: null,
  tokenType: 'Bearer',
  expiresAt: null,
  scope: null,
};
const ctx: ConnectorContext = { tenantId: 'tenant-1', connectionId: 'conn-1', credential: token };

const BASE = 'https://slack.test/api';

interface Recorded {
  method: string; // the Slack API method (last path segment)
  httpMethod: string;
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
}

function channel(id: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    name,
    is_private: false,
    is_channel: true,
    created: 1_700_000_000,
    topic: { value: 'the topic' },
    purpose: { value: 'the purpose' },
    num_members: 3,
    ...extra,
  };
}

function message(ts: string, text: string, extra: Record<string, unknown> = {}) {
  return { type: 'message', ts, user: 'U1', text, ...extra };
}

/**
 * A Slack stub. The handler is keyed by the API method; returning an object
 * merges into `{ ok: true }`, `undefined` yields `{ ok: false, error }`. Pass an
 * `{ error }` object to force a specific Slack error.
 */
function fakeSlack(handler: (req: Recorded) => unknown) {
  const calls: Recorded[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const u = new URL(url instanceof Request ? url.url : url.toString());
    const method = u.pathname.split('/').pop() ?? '';
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined;
    const record: Recorded = {
      method,
      httpMethod: init?.method ?? 'GET',
      query: u.searchParams,
      body,
    };
    calls.push(record);

    const result = handler(record) as Record<string, unknown> | undefined;
    const payload =
      result === undefined
        ? { ok: false, error: 'channel_not_found' }
        : 'error' in result
          ? { ok: false, ...result }
          : { ok: true, ...result };
    return Promise.resolve(
      new Response(JSON.stringify(payload), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch, calls };
}

let calls: Recorded[];
let connector: SlackConnector;

function connect(handler: Parameters<typeof fakeSlack>[0]) {
  const fake = fakeSlack(handler);
  calls = fake.calls;
  connector = new SlackConnector({ fetch: fake.fetch, baseUrl: BASE });
}

describe('SlackConnector — channels', () => {
  it('lists channels, prefixing the id and carrying the cursor', async () => {
    connect(({ method }) =>
      method === 'conversations.list'
        ? {
            channels: [channel('C1', 'general'), channel('C2', 'random')],
            response_metadata: { next_cursor: 'CUR' },
          }
        : undefined,
    );

    const listed = await connector.list(ctx);

    expect(listed.resources.map((r) => r.id)).toEqual(['channel:C1', 'channel:C2']);
    expect(listed.resources[0]).toMatchObject({
      type: 'channel',
      title: 'general',
      content: 'the purpose',
      parentId: null,
      metadata: { channel: 'C1', isPrivate: false, memberCount: 3 },
    });
    expect(listed.nextCursor).toBe('CUR');
  });

  it('reads a channel', async () => {
    connect(({ method, query }) => {
      if (method !== 'conversations.info') return undefined;
      expect(query.get('channel')).toBe('C1');
      return { channel: channel('C1', 'general') };
    });

    const resource = await connector.read(ctx, 'channel:C1');
    expect(resource).toMatchObject({ id: 'channel:C1', type: 'channel', title: 'general' });
  });

  it('maps a missing channel to ResourceNotFoundError', async () => {
    connect(() => undefined); // default { ok:false, error:'channel_not_found' }

    await expect(connector.read(ctx, 'channel:GONE')).rejects.toBeInstanceOf(ResourceNotFoundError);
  });
});

describe('SlackConnector — messages', () => {
  it('lists a channel’s history, parenting messages to the channel', async () => {
    connect(({ method, query }) => {
      if (method !== 'conversations.history') return undefined;
      expect(query.get('channel')).toBe('C1');
      return {
        messages: [message('1700000001.000100', 'hello'), message('1700000002.000200', 'hi')],
      };
    });

    const listed = await connector.list(ctx, { type: 'message', parentId: 'channel:C1' });

    expect(listed.resources.map((r) => r.id)).toEqual([
      'message:C1:1700000001.000100',
      'message:C1:1700000002.000200',
    ]);
    expect(listed.resources[0]).toMatchObject({
      type: 'message',
      title: 'hello',
      content: 'hello',
      parentId: 'channel:C1',
      metadata: { channel: 'C1', ts: '1700000001.000100', author: 'U1' },
    });
  });

  it('accepts a bare channel id as the parent too', async () => {
    connect(({ query }) => {
      expect(query.get('channel')).toBe('C1');
      return { messages: [message('1700000001.000100', 'hey')] };
    });

    const listed = await connector.list(ctx, { type: 'message', parentId: 'C1' });
    expect(listed.resources[0]?.id).toBe('message:C1:1700000001.000100');
  });

  it('needs a parent to list messages', async () => {
    connect(() => undefined);

    await expect(connector.list(ctx, { type: 'message' })).rejects.toThrowError(/needs a parent/);
  });

  it('reads one message at its ts, verifying the ts matches', async () => {
    connect(({ method, query }) => {
      if (method !== 'conversations.history') return undefined;
      expect(query.get('latest')).toBe('1700000001.000100');
      expect(query.get('inclusive')).toBe('true');
      return { messages: [message('1700000001.000100', 'the one')] };
    });

    const resource = await connector.read(ctx, 'message:C1:1700000001.000100');
    expect(resource).toMatchObject({ content: 'the one', metadata: { ts: '1700000001.000100' } });
  });

  it('treats a ts mismatch as not found', async () => {
    connect(() => ({ messages: [message('1700000000.999999', 'a different message')] }));

    await expect(connector.read(ctx, 'message:C1:1700000001.000100')).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it('gives a text-less message a synthesised title', async () => {
    connect(() => ({ messages: [{ type: 'message', ts: '1700000001.000100', user: 'U1' }] }));

    const resource = await connector.read(ctx, 'message:C1:1700000001.000100');
    expect(resource.title).toBe('message 1700000001.000100');
    expect(resource.content).toBeNull();
  });
});

describe('SlackConnector — search', () => {
  it('searches messages, paging by page number', async () => {
    connect(({ method, query }) => {
      if (method !== 'search.messages') return undefined;
      expect(query.get('query')).toBe('deploy');
      return {
        messages: {
          matches: [
            { ts: '1700000001.000100', text: 'deploy done', user: 'U1', channel: { id: 'C1' } },
          ],
          paging: { pages: 2, page: 1 },
        },
      };
    });

    const found = await connector.search(ctx, 'deploy');

    expect(found.resources[0]).toMatchObject({
      id: 'message:C1:1700000001.000100',
      type: 'message',
    });
    expect(found.nextCursor).toBe('2'); // more pages
  });
});

describe('SlackConnector — writes', () => {
  it('posts a message to a channel, parenting it', async () => {
    connect(({ method, httpMethod, body }) => {
      if (method !== 'chat.postMessage') return undefined;
      expect(httpMethod).toBe('POST');
      expect(body).toMatchObject({ channel: 'C1', text: 'hello team' });
      return { ts: '1700000009.000000', message: message('1700000009.000000', 'hello team') };
    });

    const created = await connector.create(ctx, {
      type: 'message',
      title: 'ignored when content is set',
      content: 'hello team',
      parentId: 'channel:C1',
    });

    expect(created.id).toBe('message:C1:1700000009.000000');
    expect(created.parentId).toBe('channel:C1');
  });

  it('needs a channel to post a message', async () => {
    connect(() => undefined);

    await expect(connector.create(ctx, { type: 'message', title: 'hi' })).rejects.toThrowError(
      /needs metadata\.channel or a parentId/,
    );
  });

  it('edits a message by channel and ts', async () => {
    connect(({ method, body }) => {
      if (method !== 'chat.update') return undefined;
      expect(body).toMatchObject({ channel: 'C1', ts: '1700000001.000100', text: 'edited' });
      return { channel: 'C1', ts: '1700000001.000100', text: 'edited' };
    });

    const updated = await connector.update(ctx, 'message:C1:1700000001.000100', {
      content: 'edited',
    });

    expect(updated.content).toBe('edited');
  });

  it('deletes a message', async () => {
    connect(({ method, body }) => {
      if (method !== 'chat.delete') return undefined;
      expect(body).toMatchObject({ channel: 'C1', ts: '1700000001.000100' });
      return { channel: 'C1', ts: '1700000001.000100' };
    });

    await connector.delete(ctx, 'message:C1:1700000001.000100');
    expect(calls.some((c) => c.method === 'chat.delete')).toBe(true);
  });

  it('refuses to edit or delete a channel', async () => {
    connect(() => ({}));

    await expect(connector.update(ctx, 'channel:C1', { content: 'x' })).rejects.toBeInstanceOf(
      ConnectorError,
    );
    await expect(connector.delete(ctx, 'channel:C1')).rejects.toBeInstanceOf(ConnectorError);
  });

  it('rejects a malformed id', async () => {
    connect(() => ({}));

    await expect(connector.read(ctx, 'C1')).rejects.toThrowError(/expected "channel:C123"/);
  });

  it('surfaces a non-not-found Slack error as a ConnectorError', async () => {
    connect(() => ({ error: 'not_in_channel' }));

    await expect(connector.read(ctx, 'channel:C1')).rejects.toBeInstanceOf(ConnectorError);
  });
});
