// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The Calendly connector, driven by a stub of the API. The translation is the
 * point: event types and scheduled events to resources with `event-type:` /
 * `event:` ids (the uuid taken from the resource URI), a scheduled event
 * parented to its event type, resolving the user URI from `/users/me` to list,
 * the `{ collection, pagination }` / `{ resource }` envelopes, and cancel-as-
 * delete. Read + cancel only, as the source allows.
 */

import { describe, expect, it } from 'vitest';

import type { ConnectorContext } from '../../src/connections/connector.js';
import { ConnectorError, ResourceNotFoundError } from '../../src/connections/connector.js';
import { CalendlyConnector } from '../../src/connections/connectors/calendly-connector.js';
import type { OAuthToken } from '../../src/connections/oauth.js';

const token: OAuthToken = {
  accessToken: 'cly-token',
  refreshToken: null,
  tokenType: 'Bearer',
  expiresAt: null,
  scope: null,
};
const ctx: ConnectorContext = { tenantId: 'tenant-1', connectionId: 'conn-1', credential: token };

const BASE = 'https://calendly.test';
const USER_URI = 'https://calendly.test/users/U1';

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
}

function eventType(uuid: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    uri: `https://calendly.test/event_types/${uuid}`,
    name,
    slug: `slug-${uuid}`,
    description_plain: 'a template',
    duration: 30,
    active: true,
    scheduling_url: `https://calendly.com/me/${uuid}`,
    created_at: '2026-07-01T00:00:00.000Z',
    ...extra,
  };
}

function scheduledEvent(uuid: string, name: string, extra: Record<string, unknown> = {}) {
  return {
    uri: `https://calendly.test/scheduled_events/${uuid}`,
    name,
    status: 'active',
    start_time: '2026-08-01T10:00:00Z',
    end_time: '2026-08-01T10:30:00Z',
    location: { type: 'zoom', join_url: 'https://zoom.us/j/1' },
    event_type: 'https://calendly.test/event_types/ET1',
    created_at: '2026-07-01T00:00:00.000Z',
    ...extra,
  };
}

function fakeCalendly(handler: (req: Recorded) => unknown) {
  const calls: Recorded[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const u = new URL(url instanceof Request ? url.url : url.toString());
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined;
    calls.push({ method: init?.method ?? 'GET', path: u.pathname, query: u.searchParams, body });

    const result = handler(calls[calls.length - 1]!);
    if (result === undefined) {
      return Promise.resolve(new Response(JSON.stringify({ title: 'Not Found' }), { status: 404 }));
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
let connector: CalendlyConnector;

function connect(handler: Parameters<typeof fakeCalendly>[0]) {
  const fake = fakeCalendly(handler);
  calls = fake.calls;
  connector = new CalendlyConnector({ fetch: fake.fetch, baseUrl: BASE });
}

describe('CalendlyConnector', () => {
  it('declares only list, read and delete', () => {
    connect(() => ({ resource: { uri: USER_URI } }));
    expect(connector.capabilities).toEqual(['list', 'read', 'delete']);
  });

  it('lists event types, resolving the user and taking the uuid from the uri', async () => {
    connect(({ path, query }) => {
      if (path === '/users/me') return { resource: { uri: USER_URI } };
      if (path === '/event_types') {
        expect(query.get('user')).toBe(USER_URI);
        return {
          collection: [eventType('ET1', '30 min call'), eventType('ET2', 'Intro')],
          pagination: { next_page_token: 'NEXT' },
        };
      }
      return undefined;
    });

    const listed = await connector.list(ctx);

    expect(listed.resources.map((r) => r.id)).toEqual(['event-type:ET1', 'event-type:ET2']);
    expect(listed.resources[0]).toMatchObject({
      type: 'event-type',
      title: '30 min call',
      url: 'https://calendly.com/me/ET1',
      metadata: { duration: 30, active: true },
    });
    expect(listed.nextCursor).toBe('NEXT');
  });

  it('lists scheduled events, parenting each to its event type', async () => {
    connect(({ path }) => {
      if (path === '/users/me') return { resource: { uri: USER_URI } };
      if (path === '/scheduled_events') return { collection: [scheduledEvent('EV1', 'Call')] };
      return undefined;
    });

    const listed = await connector.list(ctx, { type: 'event' });

    expect(listed.resources[0]).toMatchObject({
      id: 'event:EV1',
      type: 'event',
      title: 'Call',
      parentId: 'event-type:ET1',
      metadata: { status: 'active', start: '2026-08-01T10:00:00Z' },
    });
  });

  it('reads an event type (single-resource envelope)', async () => {
    connect(({ path }) =>
      path === '/event_types/ET1' ? { resource: eventType('ET1', '30 min call') } : undefined,
    );

    const resource = await connector.read(ctx, 'event-type:ET1');
    expect(resource).toMatchObject({ id: 'event-type:ET1', type: 'event-type' });
  });

  it('reads a scheduled event', async () => {
    connect(({ path }) =>
      path === '/scheduled_events/EV1' ? { resource: scheduledEvent('EV1', 'Call') } : undefined,
    );

    const resource = await connector.read(ctx, 'event:EV1');
    expect(resource).toMatchObject({ id: 'event:EV1', type: 'event', url: 'https://zoom.us/j/1' });
  });

  it('maps a 404 to ResourceNotFoundError', async () => {
    connect(() => undefined);

    await expect(connector.read(ctx, 'event:gone')).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('cancels a scheduled event on delete', async () => {
    connect(({ method, path }) =>
      method === 'POST' && path === '/scheduled_events/EV1/cancellation'
        ? { resource: { status: 'canceled' } }
        : undefined,
    );

    await connector.delete(ctx, 'event:EV1');
    expect(calls.some((c) => c.path === '/scheduled_events/EV1/cancellation')).toBe(true);
  });

  it('refuses to delete an event type', async () => {
    connect(() => ({}));

    await expect(connector.delete(ctx, 'event-type:ET1')).rejects.toBeInstanceOf(ConnectorError);
  });

  it('rejects a malformed id', async () => {
    connect(() => ({}));

    await expect(connector.read(ctx, 'EV1')).rejects.toThrowError(/expected "event-type:<uuid>"/);
  });

  it('fails when the credential is not an OAuth token', async () => {
    connect(() => ({}));
    const bad: ConnectorContext = { ...ctx, credential: { key: 'x' } };

    await expect(connector.read(bad, 'event:EV1')).rejects.toBeInstanceOf(ConnectorError);
  });
});
