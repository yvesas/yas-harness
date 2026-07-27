// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The Cal.com connector, driven by a stub of the v2 API. The translation is the
 * point: event types and bookings to resources with `event-type:`/`booking:`
 * ids, a booking parented to its event type with times in metadata, unwrapping
 * the `{ data }` envelope, booking / rescheduling / cancelling, and refusing
 * writes against an event type.
 */

import { describe, expect, it } from 'vitest';

import type { ConnectorContext } from '../../src/connections/connector.js';
import { ConnectorError, ResourceNotFoundError } from '../../src/connections/connector.js';
import { CalcomConnector } from '../../src/connections/connectors/calcom-connector.js';
import type { OAuthToken } from '../../src/connections/oauth.js';

const token: OAuthToken = {
  accessToken: 'cal_live_key',
  refreshToken: null,
  tokenType: 'Bearer',
  expiresAt: null,
  scope: null,
};
const ctx: ConnectorContext = { tenantId: 'tenant-1', connectionId: 'conn-1', credential: token };

const BASE = 'https://cal.test/v2';

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  apiVersion: string | null;
  body: Record<string, unknown> | undefined;
}

function eventType(id: number, title: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    title,
    slug: `slug-${id}`,
    description: 'a template',
    lengthInMinutes: 30,
    ...extra,
  };
}

function booking(uid: string, title: string, extra: Record<string, unknown> = {}) {
  return {
    uid,
    title,
    description: 'the notes',
    status: 'accepted',
    start: '2026-08-01T10:00:00Z',
    end: '2026-08-01T10:30:00Z',
    eventTypeId: 7,
    attendees: [{ name: 'Ana', email: 'ana@x.com', timeZone: 'UTC' }],
    createdAt: '2026-07-01T00:00:00.000Z',
    ...extra,
  };
}

/** A Cal.com stub: the handler's return is wrapped in `{ status, data }`. */
function fakeCalcom(handler: (req: Recorded) => unknown) {
  const calls: Recorded[] = [];
  const fetch: typeof globalThis.fetch = (url, init) => {
    const u = new URL(url instanceof Request ? url.url : url.toString());
    const headers = new Headers(init?.headers);
    const body = init?.body
      ? (JSON.parse(init.body as string) as Record<string, unknown>)
      : undefined;
    calls.push({
      method: init?.method ?? 'GET',
      path: u.pathname,
      query: u.searchParams,
      apiVersion: headers.get('cal-api-version'),
      body,
    });

    const result = handler(calls[calls.length - 1]!);
    if (result === undefined) {
      return Promise.resolve(new Response(JSON.stringify({ error: {} }), { status: 404 }));
    }
    return Promise.resolve(
      new Response(JSON.stringify({ status: 'success', data: result }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { fetch, calls };
}

let calls: Recorded[];
let connector: CalcomConnector;

function connect(handler: Parameters<typeof fakeCalcom>[0]) {
  const fake = fakeCalcom(handler);
  calls = fake.calls;
  connector = new CalcomConnector({ fetch: fake.fetch, baseUrl: BASE });
}

describe('CalcomConnector', () => {
  it('does not declare search (Cal.com has no free-text booking search)', () => {
    connect(() => []);
    expect(connector.capabilities).not.toContain('search');
  });

  it('lists event types, unwrapping the data envelope', async () => {
    connect(({ path, apiVersion }) => {
      if (path !== '/v2/event-types') return undefined;
      expect(apiVersion).toBe('2024-06-14');
      return [eventType(7, '30 min call'), eventType(8, 'Intro')];
    });

    const listed = await connector.list(ctx);

    expect(listed.resources.map((r) => r.id)).toEqual(['event-type:7', 'event-type:8']);
    expect(listed.resources[0]).toMatchObject({
      type: 'event-type',
      title: '30 min call',
      metadata: { eventTypeId: 7, slug: 'slug-7', lengthInMinutes: 30 },
    });
  });

  it('lists bookings, parenting them to their event type', async () => {
    connect(({ path, apiVersion }) => {
      if (path !== '/v2/bookings') return undefined;
      expect(apiVersion).toBe('2024-08-13');
      return [booking('bk1', 'Call with Ana')];
    });

    const listed = await connector.list(ctx, { type: 'booking' });

    expect(listed.resources[0]).toMatchObject({
      id: 'booking:bk1',
      type: 'booking',
      title: 'Call with Ana',
      parentId: 'event-type:7',
      metadata: { uid: 'bk1', status: 'accepted', start: '2026-08-01T10:00:00Z', eventTypeId: 7 },
    });
  });

  it('narrows a booking list to a parent event type', async () => {
    connect(({ path, query }) => {
      if (path !== '/v2/bookings') return undefined;
      expect(query.get('eventTypeId')).toBe('7');
      return [booking('bk1', 'X')];
    });

    await connector.list(ctx, { type: 'booking', parentId: 'event-type:7' });
    expect(calls.some((c) => c.query.get('eventTypeId') === '7')).toBe(true);
  });

  it('reads an event type and a booking', async () => {
    connect(({ path }) => {
      if (path === '/v2/event-types/7') return eventType(7, '30 min call');
      if (path === '/v2/bookings/bk1') return booking('bk1', 'Call');
      return undefined;
    });

    expect((await connector.read(ctx, 'event-type:7')).type).toBe('event-type');
    expect((await connector.read(ctx, 'booking:bk1')).id).toBe('booking:bk1');
  });

  it('maps a 404 to ResourceNotFoundError', async () => {
    connect(() => undefined);

    await expect(connector.read(ctx, 'booking:gone')).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('books a slot, sending the event type, start and attendee', async () => {
    connect(({ method, path, body }) => {
      if (method === 'POST' && path === '/v2/bookings') {
        expect(body).toMatchObject({
          eventTypeId: 7,
          start: '2026-08-01T10:00:00Z',
          attendee: { name: 'Ana', email: 'ana@x.com', timeZone: 'America/Sao_Paulo' },
        });
        return booking('bkNew', 'Call with Ana');
      }
      return undefined;
    });

    const created = await connector.create(ctx, {
      type: 'booking',
      title: 'ignored',
      parentId: 'event-type:7',
      metadata: {
        start: '2026-08-01T10:00:00Z',
        attendeeName: 'Ana',
        attendeeEmail: 'ana@x.com',
        timeZone: 'America/Sao_Paulo',
      },
    });

    expect(created.id).toBe('booking:bkNew');
  });

  it('needs an event type to book', async () => {
    connect(() => ({}));

    await expect(
      connector.create(ctx, {
        type: 'booking',
        title: 'x',
        metadata: { start: 's', attendeeName: 'A', attendeeEmail: 'a@x.com' },
      }),
    ).rejects.toThrowError(/needs a parentId or metadata\.eventTypeId/);
  });

  it('needs start and attendee to book', async () => {
    connect(() => ({}));

    await expect(
      connector.create(ctx, { type: 'booking', title: 'x', parentId: 'event-type:7' }),
    ).rejects.toThrowError(/needs metadata\.start/);
  });

  it('reschedules a booking on update', async () => {
    connect(({ method, path, body }) => {
      if (method === 'POST' && path === '/v2/bookings/bk1/reschedule') {
        expect(body).toEqual({ start: '2026-08-02T10:00:00Z' });
        return booking('bk1', 'Call', { start: '2026-08-02T10:00:00Z' });
      }
      return undefined;
    });

    const updated = await connector.update(ctx, 'booking:bk1', {
      metadata: { start: '2026-08-02T10:00:00Z' },
    });

    expect(updated.metadata['start']).toBe('2026-08-02T10:00:00Z');
  });

  it('needs a start to reschedule', async () => {
    connect(() => ({}));

    await expect(connector.update(ctx, 'booking:bk1', { title: 'x' })).rejects.toThrowError(
      /needs metadata\.start/,
    );
  });

  it('cancels a booking on delete', async () => {
    connect(({ method, path }) =>
      method === 'POST' && path === '/v2/bookings/bk1/cancel' ? booking('bk1', 'X') : undefined,
    );

    await connector.delete(ctx, 'booking:bk1');
    expect(calls.some((c) => c.path === '/v2/bookings/bk1/cancel')).toBe(true);
  });

  it('refuses to edit or delete an event type', async () => {
    connect(() => ({}));

    await expect(
      connector.update(ctx, 'event-type:7', { metadata: { start: 's' } }),
    ).rejects.toBeInstanceOf(ConnectorError);
    await expect(connector.delete(ctx, 'event-type:7')).rejects.toBeInstanceOf(ConnectorError);
  });

  it('does not support creating an event type', async () => {
    connect(() => ({}));

    await expect(connector.create(ctx, { type: 'event-type', title: 'x' })).rejects.toThrowError(
      /event type is not supported/,
    );
  });

  it('rejects a malformed id', async () => {
    connect(() => ({}));

    await expect(connector.read(ctx, 'bk1')).rejects.toThrowError(/expected "event-type:<id>"/);
  });

  it('fails when the credential is not a bearer token', async () => {
    connect(() => ({}));
    const bad: ConnectorContext = { ...ctx, credential: { foo: 'bar' } };

    await expect(connector.read(bad, 'booking:bk1')).rejects.toBeInstanceOf(ConnectorError);
  });
});
