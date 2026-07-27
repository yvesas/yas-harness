// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A connector for Google Calendar, covering calendars and events.
 *
 * One connection reaches both, so this is one connector with two resource
 * kinds, routed by a discriminator in the id — the multi-type shape the other
 * connectors use:
 *  - a calendar id is `calendar:<id>` (the id may be "primary" or an address)
 *  - an event id is `event:<calendarId>:<eventId>` (an event lives in a calendar)
 *
 * A calendar is a container you browse into; calendars are read-only here
 * (list, read). Events are full: list a calendar's events, read one, create,
 * edit and delete. An event's times are its own fields, so `start`/`end` (and
 * `location`) ride in `metadata`, while `content` is the description. Search is
 * per-calendar and defaults to the primary calendar.
 *
 * Nothing product-domain here: a calendar event is a record the same in a
 * language tutor and a CRM. Written against `fetch`; no dependency.
 */

import type {
  Connector,
  ConnectorCapability,
  ConnectorContext,
  ListOptions,
  Resource,
  ResourceDraft,
  ResourcePage,
  ResourcePatch,
  SearchOptions,
} from '../connector.js';
import { ConnectorError, ResourceNotFoundError } from '../connector.js';
import { isOAuthToken } from '../oauth.js';

const CONNECTOR_ID = 'google-calendar';
const CALENDAR_API = 'https://www.googleapis.com/calendar/v3';
const DEFAULT_LIMIT = 25;
const CALENDAR_PREFIX = 'calendar:';
const EVENT_PREFIX = 'event:';
const PRIMARY_CALENDAR = 'primary';

export interface GoogleCalendarConnectorOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** Overrides the API base; only for tests. */
  readonly baseUrl?: string;
}

interface CalendarResource {
  id: string;
  summary?: string;
  description?: string;
  timeZone?: string;
}

interface EventDateTime {
  dateTime?: string;
  date?: string;
  timeZone?: string;
}

interface CalendarEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  htmlLink?: string;
  start?: EventDateTime;
  end?: EventDateTime;
  created?: string;
  updated?: string;
}

type Ref =
  | { readonly kind: 'calendar'; readonly calendarId: string }
  | { readonly kind: 'event'; readonly calendarId: string; readonly eventId: string };

export class GoogleCalendarConnector implements Connector {
  readonly id = CONNECTOR_ID;
  readonly description = 'Google Calendar calendars and their events.';
  // Calendars are read-only; the write capabilities are for events. A write
  // against a calendar id is refused with a clear error.
  readonly capabilities: readonly ConnectorCapability[] = [
    'list',
    'read',
    'search',
    'create',
    'update',
    'delete',
  ];

  readonly #fetch: typeof globalThis.fetch;
  readonly #apiBase: string;

  constructor(options: GoogleCalendarConnectorOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiBase = options.baseUrl ?? CALENDAR_API;
  }

  list(context: ConnectorContext, options: ListOptions = {}): Promise<ResourcePage> {
    return options.type === 'event'
      ? this.#listEvents(context, options)
      : this.#listCalendars(context, options);
  }

  // async so a parse failure surfaces as a rejected promise, not a throw.
  async read(context: ConnectorContext, id: string): Promise<Resource> {
    const ref = parseRef(id);
    return ref.kind === 'calendar'
      ? this.#readCalendar(context, ref.calendarId)
      : this.#readEvent(context, ref.calendarId, ref.eventId);
  }

  async search(
    context: ConnectorContext,
    query: string,
    options: SearchOptions = {},
  ): Promise<ResourcePage> {
    // Event search is per-calendar; default to the primary calendar.
    const params = new URLSearchParams({
      q: query,
      maxResults: String(options.limit ?? DEFAULT_LIMIT),
    });
    if (options.cursor) {
      params.set('pageToken', options.cursor);
    }
    const body = await this.#api<{ items?: CalendarEvent[]; nextPageToken?: string }>(
      context,
      'GET',
      `/calendars/${encodeURIComponent(PRIMARY_CALENDAR)}/events?${params.toString()}`,
    );
    return {
      resources: (body.items ?? []).map((event) => eventToResource(event, PRIMARY_CALENDAR)),
      nextCursor: body.nextPageToken ?? null,
    };
  }

  create(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    if (draft.type === 'calendar') {
      throw new ConnectorError('creating a Google calendar is not supported', this.id);
    }
    return this.#createEvent(context, draft);
  }

  async update(context: ConnectorContext, id: string, patch: ResourcePatch): Promise<Resource> {
    const ref = parseRef(id);
    if (ref.kind !== 'event') {
      throw new ConnectorError('a Google calendar cannot be edited', this.id);
    }
    const body: Record<string, unknown> = {};
    if (patch.title !== undefined) body['summary'] = patch.title;
    if (patch.content !== undefined) body['description'] = patch.content;
    const start = timeFrom(patch.metadata?.['start']);
    const end = timeFrom(patch.metadata?.['end']);
    if (start) body['start'] = start;
    if (end) body['end'] = end;
    if (typeof patch.metadata?.['location'] === 'string')
      body['location'] = patch.metadata['location'];

    const updated = await this.#api<CalendarEvent>(
      context,
      'PATCH',
      `/calendars/${encodeURIComponent(ref.calendarId)}/events/${encodeURIComponent(ref.eventId)}`,
      body,
    );
    return eventToResource(updated, ref.calendarId);
  }

  async delete(context: ConnectorContext, id: string): Promise<void> {
    const ref = parseRef(id);
    if (ref.kind !== 'event') {
      throw new ConnectorError('a Google calendar cannot be deleted', this.id);
    }
    await this.#api(
      context,
      'DELETE',
      `/calendars/${encodeURIComponent(ref.calendarId)}/events/${encodeURIComponent(ref.eventId)}`,
    );
  }

  // --- calendars ------------------------------------------------------------

  async #listCalendars(context: ConnectorContext, options: ListOptions): Promise<ResourcePage> {
    const params = new URLSearchParams({ maxResults: String(options.limit ?? DEFAULT_LIMIT) });
    if (options.cursor) {
      params.set('pageToken', options.cursor);
    }
    const body = await this.#api<{ items?: CalendarResource[]; nextPageToken?: string }>(
      context,
      'GET',
      `/users/me/calendarList?${params.toString()}`,
    );
    return {
      resources: (body.items ?? []).map(calendarToResource),
      nextCursor: body.nextPageToken ?? null,
    };
  }

  async #readCalendar(context: ConnectorContext, calendarId: string): Promise<Resource> {
    const calendar = await this.#api<CalendarResource>(
      context,
      'GET',
      `/calendars/${encodeURIComponent(calendarId)}`,
    );
    return calendarToResource(calendar);
  }

  // --- events ---------------------------------------------------------------

  async #listEvents(context: ConnectorContext, options: ListOptions): Promise<ResourcePage> {
    if (!options.parentId) {
      throw new ConnectorError(
        'listing Google Calendar events needs a parent (a calendar id)',
        this.id,
      );
    }
    const calendarId = calendarFromParent(options.parentId);
    const params = new URLSearchParams({
      maxResults: String(options.limit ?? DEFAULT_LIMIT),
      singleEvents: 'true',
      orderBy: 'startTime',
    });
    if (options.cursor) {
      params.set('pageToken', options.cursor);
    }
    const body = await this.#api<{ items?: CalendarEvent[]; nextPageToken?: string }>(
      context,
      'GET',
      `/calendars/${encodeURIComponent(calendarId)}/events?${params.toString()}`,
    );
    return {
      resources: (body.items ?? []).map((event) => eventToResource(event, calendarId)),
      nextCursor: body.nextPageToken ?? null,
    };
  }

  async #readEvent(
    context: ConnectorContext,
    calendarId: string,
    eventId: string,
  ): Promise<Resource> {
    const event = await this.#api<CalendarEvent>(
      context,
      'GET',
      `/calendars/${encodeURIComponent(calendarId)}/events/${encodeURIComponent(eventId)}`,
    );
    return eventToResource(event, calendarId);
  }

  async #createEvent(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    const parentRef = draft.parentId ?? draft.metadata?.['calendar'];
    if (typeof parentRef !== 'string') {
      throw new ConnectorError(
        'creating a calendar event needs a parentId or metadata.calendar (the calendar id)',
        this.id,
      );
    }
    const calendarId = calendarFromParent(parentRef);
    const start = timeFrom(draft.metadata?.['start']);
    const end = timeFrom(draft.metadata?.['end']);
    if (!start || !end) {
      throw new ConnectorError(
        'creating a calendar event needs metadata.start and metadata.end (ISO date or date-time)',
        this.id,
      );
    }

    const created = await this.#api<CalendarEvent>(
      context,
      'POST',
      `/calendars/${encodeURIComponent(calendarId)}/events`,
      {
        summary: draft.title,
        ...(draft.content ? { description: draft.content } : {}),
        ...(typeof draft.metadata?.['location'] === 'string'
          ? { location: draft.metadata['location'] }
          : {}),
        start,
        end,
      },
    );
    return eventToResource(created, calendarId);
  }

  // --- transport ------------------------------------------------------------

  async #api<T>(
    context: ConnectorContext,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.#fetch(`${this.#apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#accessToken(context)}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (response.status === 404) {
      throw new ResourceNotFoundError(this.id, path);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ConnectorError(
        `google calendar responded ${response.status}: ${text.slice(0, 300)}`,
        this.id,
      );
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  #accessToken(context: ConnectorContext): string {
    if (!isOAuthToken(context.credential)) {
      throw new ConnectorError('google-calendar connection has no OAuth token', this.id);
    }
    return context.credential.accessToken;
  }
}

// --- translation ------------------------------------------------------------

function calendarToResource(calendar: CalendarResource): Resource {
  const content = calendar.description ?? null;
  return {
    id: `${CALENDAR_PREFIX}${calendar.id}`,
    type: 'calendar',
    title: calendar.summary ?? calendar.id,
    content,
    mimeType: content === null ? null : 'text/plain',
    parentId: null,
    url: null,
    metadata: {
      calendar: calendar.id,
      ...(calendar.timeZone ? { timeZone: calendar.timeZone } : {}),
    },
    createdAt: null,
    updatedAt: null,
  };
}

function eventToResource(event: CalendarEvent, calendarId: string): Resource {
  const content = event.description ?? null;
  return {
    id: `${EVENT_PREFIX}${calendarId}:${event.id}`,
    type: 'event',
    title: event.summary ?? '(no title)',
    content,
    mimeType: content === null ? null : 'text/plain',
    parentId: `${CALENDAR_PREFIX}${calendarId}`,
    url: event.htmlLink ?? null,
    metadata: {
      calendar: calendarId,
      eventId: event.id,
      ...(dateTimeOf(event.start) ? { start: dateTimeOf(event.start) } : {}),
      ...(dateTimeOf(event.end) ? { end: dateTimeOf(event.end) } : {}),
      ...(event.location ? { location: event.location } : {}),
      ...(event.status ? { status: event.status } : {}),
    },
    createdAt: event.created ? new Date(event.created) : null,
    updatedAt: event.updated ? new Date(event.updated) : null,
  };
}

/** An event's time is a dateTime (timed) or a date (all-day); take whichever. */
function dateTimeOf(when: EventDateTime | undefined): string | null {
  return when?.dateTime ?? when?.date ?? null;
}

/**
 * Build an event time from a caller-supplied ISO string: a value with a "T" is
 * a timed `dateTime`, otherwise an all-day `date`. Non-strings yield nothing.
 */
function timeFrom(value: unknown): { dateTime: string } | { date: string } | null {
  if (typeof value !== 'string' || value === '') {
    return null;
  }
  return value.includes('T') ? { dateTime: value } : { date: value };
}

// --- id helpers -------------------------------------------------------------

function parseRef(id: string): Ref {
  if (id.startsWith(CALENDAR_PREFIX)) {
    const calendarId = id.slice(CALENDAR_PREFIX.length);
    if (calendarId === '') throw invalidId(id);
    return { kind: 'calendar', calendarId };
  }
  if (id.startsWith(EVENT_PREFIX)) {
    const rest = id.slice(EVENT_PREFIX.length);
    const colon = rest.indexOf(':');
    if (colon <= 0 || colon === rest.length - 1) {
      throw invalidId(id);
    }
    return { kind: 'event', calendarId: rest.slice(0, colon), eventId: rest.slice(colon + 1) };
  }
  throw invalidId(id);
}

/** A parent may be a calendar resource id (`calendar:<id>`) or the bare id. */
function calendarFromParent(parentId: string): string {
  return parentId.startsWith(CALENDAR_PREFIX) ? parentId.slice(CALENDAR_PREFIX.length) : parentId;
}

function invalidId(id: string): ConnectorError {
  return new ConnectorError(
    `invalid Google Calendar id "${id}"; expected "calendar:<id>" or "event:<calendarId>:<eventId>"`,
    CONNECTOR_ID,
  );
}
