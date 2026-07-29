// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A connector for Cal.com (the open-source scheduling tool), covering event
 * types and bookings.
 *
 * One connection reaches both, so this is one connector with two resource
 * kinds, routed by a discriminator in the id:
 *  - an event type id is `event-type:<id>` (a bookable template)
 *  - a booking id is `booking:<uid>` (a scheduled meeting)
 *
 * Event types are read-only here (list, read) — they are the templates a
 * booking is made against. Bookings are the events: list them, read one, create
 * (book a slot), update (reschedule) and delete (cancel). A booking hangs off
 * its event type, so its `parentId` is the event type's resource id.
 *
 * Cal.com has no free-text search over bookings, so this connector does not
 * declare `search` — it exposes only what the source supports. Nothing
 * product-domain here: a booking is a scheduled record, the same in a language
 * tutor and a CRM. Written against `fetch`; no dependency. The credential is a
 * bearer token — a Cal.com API key or an OAuth access token, stored as one.
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
} from '../connector.js';
import { ConnectorError, ResourceNotFoundError } from '../connector.js';
import { isOAuthToken } from '../oauth.js';

const CONNECTOR_ID = 'calcom';
const CALCOM_API = 'https://api.cal.com/v2';
const DEFAULT_LIMIT = 25;
const EVENT_TYPE_PREFIX = 'event-type:';
const BOOKING_PREFIX = 'booking:';
// Cal.com pins each endpoint group to a dated API version via this header.
const BOOKINGS_VERSION = '2024-08-13';
const EVENT_TYPES_VERSION = '2024-06-14';

export interface CalcomConnectorOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** Overrides the API base; only for tests or self-hosting. */
  readonly baseUrl?: string;
}

interface CalcomEventType {
  id: number;
  title?: string;
  slug?: string;
  description?: string;
  lengthInMinutes?: number;
}

interface CalcomAttendee {
  name?: string;
  email?: string;
  timeZone?: string;
}

interface CalcomBooking {
  uid: string;
  title?: string;
  description?: string;
  status?: string;
  start?: string;
  end?: string;
  meetingUrl?: string;
  eventTypeId?: number;
  attendees?: CalcomAttendee[];
  createdAt?: string;
  updatedAt?: string;
}

type Ref =
  | { readonly kind: 'event-type'; readonly id: string }
  | { readonly kind: 'booking'; readonly uid: string };

export class CalcomConnector implements Connector {
  readonly id = CONNECTOR_ID;
  readonly description = 'Cal.com event types and bookings.';
  // No search: Cal.com has no free-text booking search. Event types are
  // read-only; the write capabilities are for bookings.
  readonly capabilities: readonly ConnectorCapability[] = [
    'list',
    'read',
    'create',
    'update',
    'delete',
  ];

  readonly #fetch: typeof globalThis.fetch;
  readonly #apiBase: string;

  constructor(options: CalcomConnectorOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiBase = options.baseUrl ?? CALCOM_API;
  }

  list(context: ConnectorContext, options: ListOptions = {}): Promise<ResourcePage> {
    return options.type === 'booking'
      ? this.#listBookings(context, options)
      : this.#listEventTypes(context, options);
  }

  async read(context: ConnectorContext, id: string): Promise<Resource> {
    const ref = parseRef(id);
    return ref.kind === 'event-type'
      ? eventTypeToResource(await this.#getEventType(context, ref.id))
      : bookingToResource(await this.#getBooking(context, ref.uid));
  }

  async create(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    if (draft.type === 'event-type') {
      throw new ConnectorError('creating a Cal.com event type is not supported', this.id);
    }
    return this.#createBooking(context, draft);
  }

  async update(context: ConnectorContext, id: string, patch: ResourcePatch): Promise<Resource> {
    const ref = parseRef(id);
    if (ref.kind !== 'booking') {
      throw new ConnectorError('a Cal.com event type cannot be edited', this.id);
    }
    // The one edit Cal.com models for a booking is a reschedule: a new start.
    const start = patch.metadata?.['start'];
    if (typeof start !== 'string') {
      throw new ConnectorError(
        'editing a Cal.com booking reschedules it and needs metadata.start (an ISO date-time)',
        this.id,
      );
    }
    const booking = await this.#api<CalcomBooking>(
      context,
      'POST',
      `/bookings/${encodeURIComponent(ref.uid)}/reschedule`,
      BOOKINGS_VERSION,
      { start },
    );
    return bookingToResource(booking);
  }

  async delete(context: ConnectorContext, id: string): Promise<void> {
    const ref = parseRef(id);
    if (ref.kind !== 'booking') {
      throw new ConnectorError('a Cal.com event type cannot be deleted', this.id);
    }
    // Cancelling is Cal.com's delete for a booking.
    await this.#api(
      context,
      'POST',
      `/bookings/${encodeURIComponent(ref.uid)}/cancel`,
      BOOKINGS_VERSION,
      {},
    );
  }

  // --- event types ----------------------------------------------------------

  async #listEventTypes(context: ConnectorContext, options: ListOptions): Promise<ResourcePage> {
    const data = await this.#api<CalcomEventType[]>(
      context,
      'GET',
      `/event-types?${pageParams(options).toString()}`,
      EVENT_TYPES_VERSION,
    );
    return page(data, options, eventTypeToResource);
  }

  async #getEventType(context: ConnectorContext, id: string): Promise<CalcomEventType> {
    return this.#api<CalcomEventType>(
      context,
      'GET',
      `/event-types/${encodeURIComponent(id)}`,
      EVENT_TYPES_VERSION,
    );
  }

  // --- bookings -------------------------------------------------------------

  async #listBookings(context: ConnectorContext, options: ListOptions): Promise<ResourcePage> {
    const params = pageParams(options);
    // A parent narrows to that event type's bookings.
    if (options.parentId) {
      params.set('eventTypeId', eventTypeIdFrom(options.parentId));
    }
    const data = await this.#api<CalcomBooking[]>(
      context,
      'GET',
      `/bookings?${params.toString()}`,
      BOOKINGS_VERSION,
    );
    return page(data, options, bookingToResource);
  }

  async #getBooking(context: ConnectorContext, uid: string): Promise<CalcomBooking> {
    return this.#api<CalcomBooking>(
      context,
      'GET',
      `/bookings/${encodeURIComponent(uid)}`,
      BOOKINGS_VERSION,
    );
  }

  async #createBooking(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    const eventTypeRef = draft.parentId ?? draft.metadata?.['eventTypeId'];
    const eventTypeId =
      typeof eventTypeRef === 'string' ? eventTypeIdFrom(eventTypeRef) : eventTypeRef;
    if (typeof eventTypeId !== 'number' && typeof eventTypeId !== 'string') {
      throw new ConnectorError(
        'booking a Cal.com slot needs a parentId or metadata.eventTypeId (the event type)',
        this.id,
      );
    }
    const start = draft.metadata?.['start'];
    const email = draft.metadata?.['attendeeEmail'];
    const name = draft.metadata?.['attendeeName'];
    if (typeof start !== 'string' || typeof email !== 'string' || typeof name !== 'string') {
      throw new ConnectorError(
        'booking a Cal.com slot needs metadata.start, metadata.attendeeName and metadata.attendeeEmail',
        this.id,
      );
    }

    const booking = await this.#api<CalcomBooking>(context, 'POST', '/bookings', BOOKINGS_VERSION, {
      eventTypeId: Number(eventTypeId),
      start,
      attendee: {
        name,
        email,
        timeZone:
          typeof draft.metadata?.['timeZone'] === 'string' ? draft.metadata['timeZone'] : 'UTC',
      },
    });
    return bookingToResource(booking);
  }

  // --- transport ------------------------------------------------------------

  /** A Cal.com v2 call: bearer auth, a dated version header, `{ data }` envelope. */
  async #api<T>(
    context: ConnectorContext,
    method: string,
    path: string,
    apiVersion: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.#fetch(`${this.#apiBase}${path}`, {
      signal: context.signal ?? null,
      method,
      headers: {
        authorization: `Bearer ${this.#accessToken(context)}`,
        'cal-api-version': apiVersion,
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
        `calcom responded ${response.status}: ${text.slice(0, 300)}`,
        this.id,
      );
    }
    const envelope = (await response.json()) as { status?: string; data?: T };
    if (envelope.data === undefined) {
      throw new ConnectorError('calcom response had no data', this.id);
    }
    return envelope.data;
  }

  #accessToken(context: ConnectorContext): string {
    if (!isOAuthToken(context.credential)) {
      throw new ConnectorError('calcom connection has no bearer token', this.id);
    }
    return context.credential.accessToken;
  }
}

// --- translation ------------------------------------------------------------

function eventTypeToResource(eventType: CalcomEventType): Resource {
  const content = eventType.description ?? null;
  return {
    id: `${EVENT_TYPE_PREFIX}${eventType.id}`,
    type: 'event-type',
    title: eventType.title ?? eventType.slug ?? String(eventType.id),
    content,
    mimeType: content === null ? null : 'text/plain',
    parentId: null,
    url: null,
    metadata: {
      eventTypeId: eventType.id,
      ...(eventType.slug ? { slug: eventType.slug } : {}),
      ...(typeof eventType.lengthInMinutes === 'number'
        ? { lengthInMinutes: eventType.lengthInMinutes }
        : {}),
    },
    createdAt: null,
    updatedAt: null,
  };
}

function bookingToResource(booking: CalcomBooking): Resource {
  const content = booking.description ?? null;
  return {
    id: `${BOOKING_PREFIX}${booking.uid}`,
    type: 'booking',
    title: booking.title ?? `booking ${booking.uid}`,
    content,
    mimeType: content === null ? null : 'text/plain',
    parentId: booking.eventTypeId ? `${EVENT_TYPE_PREFIX}${booking.eventTypeId}` : null,
    url: booking.meetingUrl ?? null,
    metadata: {
      uid: booking.uid,
      ...(booking.status ? { status: booking.status } : {}),
      ...(booking.start ? { start: booking.start } : {}),
      ...(booking.end ? { end: booking.end } : {}),
      ...(typeof booking.eventTypeId === 'number' ? { eventTypeId: booking.eventTypeId } : {}),
      ...(booking.attendees ? { attendees: booking.attendees } : {}),
    },
    createdAt: booking.createdAt ? new Date(booking.createdAt) : null,
    updatedAt: booking.updatedAt ? new Date(booking.updatedAt) : null,
  };
}

// --- helpers ----------------------------------------------------------------

/** Cal.com pages with take/skip; carry `skip` as the opaque cursor. */
function pageParams(options: ListOptions): URLSearchParams {
  const take = options.limit ?? DEFAULT_LIMIT;
  const params = new URLSearchParams({ take: String(take) });
  if (options.cursor) {
    params.set('skip', options.cursor);
  }
  return params;
}

/** Build a page, computing the next skip when a full page came back. */
function page<T>(
  items: T[],
  options: ListOptions,
  toResource: (item: T) => Resource,
): ResourcePage {
  const take = options.limit ?? DEFAULT_LIMIT;
  const skip = options.cursor ? Number(options.cursor) : 0;
  const list = items ?? [];
  return {
    resources: list.map(toResource),
    nextCursor: list.length === take ? String(skip + take) : null,
  };
}

// --- id helpers -------------------------------------------------------------

function parseRef(id: string): Ref {
  if (id.startsWith(EVENT_TYPE_PREFIX)) {
    const value = id.slice(EVENT_TYPE_PREFIX.length);
    if (value === '') throw invalidId(id);
    return { kind: 'event-type', id: value };
  }
  if (id.startsWith(BOOKING_PREFIX)) {
    const value = id.slice(BOOKING_PREFIX.length);
    if (value === '') throw invalidId(id);
    return { kind: 'booking', uid: value };
  }
  throw invalidId(id);
}

/** An event type reference may be a resource id (`event-type:7`) or the bare id. */
function eventTypeIdFrom(ref: string): string {
  return ref.startsWith(EVENT_TYPE_PREFIX) ? ref.slice(EVENT_TYPE_PREFIX.length) : ref;
}

function invalidId(id: string): ConnectorError {
  return new ConnectorError(
    `invalid Cal.com id "${id}"; expected "event-type:<id>" or "booking:<uid>"`,
    CONNECTOR_ID,
  );
}
