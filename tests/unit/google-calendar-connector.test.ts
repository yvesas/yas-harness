// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The Google Calendar connector, driven by a stub of the API. The translation
 * is the point: calendars and events to resources with `calendar:`/`event:`
 * ids, an event parented to its calendar with times in metadata, listing a
 * calendar's events, search over the primary calendar, and create/edit/delete
 * of events (with calendars rejected for writes).
 */

import { describe, expect, it } from 'vitest';

import type { ConnectorContext } from '../../src/connections/connector.js';
import { ConnectorError, ResourceNotFoundError } from '../../src/connections/connector.js';
import { GoogleCalendarConnector } from '../../src/connections/connectors/google-calendar-connector.js';
import type { OAuthToken } from '../../src/connections/oauth.js';

const token: OAuthToken = {
  accessToken: 'g-token',
  refreshToken: null,
  tokenType: 'Bearer',
  expiresAt: null,
  scope: null,
};
const ctx: ConnectorContext = { tenantId: 'tenant-1', connectionId: 'conn-1', credential: token };

const BASE = 'https://cal.test/v3';

interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: Record<string, unknown> | undefined;
}

function calendar(id: string, summary: string, extra: Record<string, unknown> = {}) {
  return { id, summary, description: 'a calendar', timeZone: 'America/Sao_Paulo', ...extra };
}

function event(id: string, summary: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    summary,
    description: 'the details',
    location: 'Room 1',
    status: 'confirmed',
    htmlLink: `https://calendar.google.com/event?eid=${id}`,
    start: { dateTime: '2026-08-01T10:00:00-03:00' },
    end: { dateTime: '2026-08-01T11:00:00-03:00' },
    created: '2026-07-01T00:00:00.000Z',
    updated: '2026-07-02T00:00:00.000Z',
    ...extra,
  };
}

function fakeCalendar(handler: (req: Recorded) => unknown) {
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
      return Promise.resolve(new Response(JSON.stringify({ error: {} }), { status: 404 }));
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
let connector: GoogleCalendarConnector;

function connect(handler: Parameters<typeof fakeCalendar>[0]) {
  const fake = fakeCalendar(handler);
  calls = fake.calls;
  connector = new GoogleCalendarConnector({ fetch: fake.fetch, baseUrl: BASE });
}

describe('GoogleCalendarConnector — calendars', () => {
  it('lists the user’s calendars, prefixing the id', async () => {
    connect(({ path }) =>
      path === '/v3/users/me/calendarList'
        ? {
            items: [calendar('primary', 'My calendar'), calendar('team@x.com', 'Team')],
            nextPageToken: 'CUR',
          }
        : undefined,
    );

    const listed = await connector.list(ctx);

    expect(listed.resources.map((r) => r.id)).toEqual(['calendar:primary', 'calendar:team@x.com']);
    expect(listed.resources[0]).toMatchObject({
      type: 'calendar',
      title: 'My calendar',
      parentId: null,
      metadata: { calendar: 'primary', timeZone: 'America/Sao_Paulo' },
    });
    expect(listed.nextCursor).toBe('CUR');
  });

  it('reads a calendar', async () => {
    connect(({ path }) =>
      path === '/v3/calendars/primary' ? calendar('primary', 'My calendar') : undefined,
    );

    const resource = await connector.read(ctx, 'calendar:primary');
    expect(resource).toMatchObject({
      id: 'calendar:primary',
      type: 'calendar',
      title: 'My calendar',
    });
  });
});

describe('GoogleCalendarConnector — events', () => {
  it('lists a calendar’s events, parenting them and carrying the times', async () => {
    connect(({ path, query }) => {
      if (path !== '/v3/calendars/primary/events') return undefined;
      expect(query.get('singleEvents')).toBe('true');
      return { items: [event('e1', 'Standup')], nextPageToken: undefined };
    });

    const listed = await connector.list(ctx, { type: 'event', parentId: 'calendar:primary' });

    expect(listed.resources[0]).toMatchObject({
      id: 'event:primary:e1',
      type: 'event',
      title: 'Standup',
      content: 'the details',
      parentId: 'calendar:primary',
      metadata: {
        calendar: 'primary',
        eventId: 'e1',
        start: '2026-08-01T10:00:00-03:00',
        location: 'Room 1',
        status: 'confirmed',
      },
    });
  });

  it('accepts a bare calendar id as the parent', async () => {
    connect(({ path }) =>
      path === '/v3/calendars/primary/events' ? { items: [event('e1', 'X')] } : undefined,
    );

    const listed = await connector.list(ctx, { type: 'event', parentId: 'primary' });
    expect(listed.resources[0]?.id).toBe('event:primary:e1');
  });

  it('needs a parent to list events', async () => {
    connect(() => undefined);

    await expect(connector.list(ctx, { type: 'event' })).rejects.toThrowError(/needs a parent/);
  });

  it('reads an event, mapping its all-day date when there is no dateTime', async () => {
    connect(({ path }) =>
      path === '/v3/calendars/primary/events/e1'
        ? event('e1', 'Holiday', { start: { date: '2026-12-25' }, end: { date: '2026-12-26' } })
        : undefined,
    );

    const resource = await connector.read(ctx, 'event:primary:e1');
    expect(resource.metadata).toMatchObject({ start: '2026-12-25', end: '2026-12-26' });
  });

  it('maps a 404 to ResourceNotFoundError', async () => {
    connect(() => undefined);

    await expect(connector.read(ctx, 'event:primary:gone')).rejects.toBeInstanceOf(
      ResourceNotFoundError,
    );
  });

  it('searches events on the primary calendar', async () => {
    connect(({ path, query }) => {
      if (path !== '/v3/calendars/primary/events') return undefined;
      expect(query.get('q')).toBe('lunch');
      return { items: [event('e2', 'Lunch')] };
    });

    const found = await connector.search(ctx, 'lunch');
    expect(found.resources[0]?.id).toBe('event:primary:e2');
  });
});

describe('GoogleCalendarConnector — writes', () => {
  it('creates a timed event, sending start and end', async () => {
    connect(({ method, path, body }) => {
      if (method === 'POST' && path === '/v3/calendars/primary/events') {
        expect(body).toMatchObject({
          summary: 'Review',
          description: 'quarterly',
          location: 'HQ',
          start: { dateTime: '2026-08-01T14:00:00-03:00' },
          end: { dateTime: '2026-08-01T15:00:00-03:00' },
        });
        return event('new1', 'Review');
      }
      return undefined;
    });

    const created = await connector.create(ctx, {
      type: 'event',
      title: 'Review',
      content: 'quarterly',
      parentId: 'calendar:primary',
      metadata: {
        start: '2026-08-01T14:00:00-03:00',
        end: '2026-08-01T15:00:00-03:00',
        location: 'HQ',
      },
    });

    expect(created.id).toBe('event:primary:new1');
  });

  it('creates an all-day event from date-only times', async () => {
    connect(({ method, path, body }) => {
      if (method === 'POST' && path === '/v3/calendars/primary/events') {
        expect(body).toMatchObject({ start: { date: '2026-12-25' }, end: { date: '2026-12-26' } });
        return event('h1', 'Holiday');
      }
      return undefined;
    });

    await connector.create(ctx, {
      type: 'event',
      title: 'Holiday',
      parentId: 'primary',
      metadata: { start: '2026-12-25', end: '2026-12-26' },
    });
  });

  it('needs start and end to create an event', async () => {
    connect(() => ({}));

    await expect(
      connector.create(ctx, { type: 'event', title: 'When?', parentId: 'primary' }),
    ).rejects.toThrowError(/needs metadata\.start and metadata\.end/);
  });

  it('needs a calendar to create an event', async () => {
    connect(() => ({}));

    await expect(
      connector.create(ctx, {
        type: 'event',
        title: 'X',
        metadata: { start: '2026-12-25', end: '2026-12-26' },
      }),
    ).rejects.toThrowError(/needs a parentId or metadata\.calendar/);
  });

  it('edits an event, patching only what is given', async () => {
    connect(({ method, path, body }) => {
      if (method === 'PATCH' && path === '/v3/calendars/primary/events/e1') {
        expect(body).toEqual({
          summary: 'Renamed',
          start: { dateTime: '2026-08-02T10:00:00-03:00' },
        });
        return event('e1', 'Renamed');
      }
      return undefined;
    });

    const updated = await connector.update(ctx, 'event:primary:e1', {
      title: 'Renamed',
      metadata: { start: '2026-08-02T10:00:00-03:00' },
    });

    expect(updated.title).toBe('Renamed');
  });

  it('deletes an event', async () => {
    connect(({ method, path }) =>
      method === 'DELETE' && path === '/v3/calendars/primary/events/e1' ? {} : undefined,
    );

    await connector.delete(ctx, 'event:primary:e1');
    expect(calls.some((c) => c.method === 'DELETE')).toBe(true);
  });

  it('refuses to edit or delete a calendar', async () => {
    connect(() => ({}));

    await expect(connector.update(ctx, 'calendar:primary', { title: 'x' })).rejects.toBeInstanceOf(
      ConnectorError,
    );
    await expect(connector.delete(ctx, 'calendar:primary')).rejects.toBeInstanceOf(ConnectorError);
  });

  it('rejects a malformed id', async () => {
    connect(() => ({}));

    await expect(connector.read(ctx, 'primary')).rejects.toThrowError(/expected "calendar:<id>"/);
  });

  it('fails when the credential is not an OAuth token', async () => {
    connect(() => ({}));
    const bad: ConnectorContext = { ...ctx, credential: { apiKey: 'nope' } };

    await expect(connector.read(bad, 'calendar:primary')).rejects.toBeInstanceOf(ConnectorError);
  });
});
