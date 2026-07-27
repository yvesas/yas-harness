// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A connector for Calendly, covering event types and scheduled events.
 *
 * One connection reaches both, so this is one connector with two resource
 * kinds, routed by a discriminator in the id:
 *  - an event type id is `event-type:<uuid>` (a bookable template)
 *  - a scheduled event id is `event:<uuid>` (an actual booking)
 *
 * Calendly's API is read-mostly on purpose: it does not create arbitrary
 * scheduled events (they are created when an invitee books through a link), and
 * it does not reschedule one over the API. So the connector honestly declares
 * only what the source supports — list, read, and delete (which cancels a
 * scheduled event). Event types are read-only. A scheduled event hangs off its
 * event type, so its `parentId` is the event type's resource id.
 *
 * Listing needs the account's user URI, which the connector resolves from
 * `/users/me` — the caller does not have to know it. Nothing product-domain
 * here: a scheduled event is a record the same in a language tutor and a CRM.
 * Written against `fetch`; no dependency.
 */

import type {
  Connector,
  ConnectorCapability,
  ConnectorContext,
  ListOptions,
  Resource,
  ResourcePage,
} from '../connector.js';
import { ConnectorError, ResourceNotFoundError } from '../connector.js';
import { isOAuthToken } from '../oauth.js';

const CONNECTOR_ID = 'calendly';
const CALENDLY_API = 'https://api.calendly.com';
const DEFAULT_LIMIT = 25;
const EVENT_TYPE_PREFIX = 'event-type:';
const EVENT_PREFIX = 'event:';
const SLASH = '/'.charCodeAt(0);

export interface CalendlyConnectorOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** Overrides the API base; only for tests. */
  readonly baseUrl?: string;
}

interface CalendlyEventType {
  uri: string;
  name?: string;
  slug?: string;
  description_plain?: string;
  duration?: number;
  active?: boolean;
  scheduling_url?: string;
  created_at?: string;
  updated_at?: string;
}

interface CalendlyEvent {
  uri: string;
  name?: string;
  status?: string;
  start_time?: string;
  end_time?: string;
  location?: { type?: string; location?: string; join_url?: string };
  event_type?: string; // a URI
  created_at?: string;
  updated_at?: string;
}

interface Pagination {
  next_page_token?: string | null;
}

type Ref =
  | { readonly kind: 'event-type'; readonly uuid: string }
  | { readonly kind: 'event'; readonly uuid: string };

export class CalendlyConnector implements Connector {
  readonly id = CONNECTOR_ID;
  readonly description = 'Calendly event types and scheduled events.';
  // Read + cancel only: Calendly does not create or reschedule scheduled events
  // over its API, so the connector declares only what the source supports.
  readonly capabilities: readonly ConnectorCapability[] = ['list', 'read', 'delete'];

  readonly #fetch: typeof globalThis.fetch;
  readonly #apiBase: string;

  constructor(options: CalendlyConnectorOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiBase = options.baseUrl ?? CALENDLY_API;
  }

  list(context: ConnectorContext, options: ListOptions = {}): Promise<ResourcePage> {
    return options.type === 'event'
      ? this.#listEvents(context, options)
      : this.#listEventTypes(context, options);
  }

  async read(context: ConnectorContext, id: string): Promise<Resource> {
    const ref = parseRef(id);
    if (ref.kind === 'event-type') {
      const body = await this.#api<{ resource: CalendlyEventType }>(
        context,
        'GET',
        `/event_types/${encodeURIComponent(ref.uuid)}`,
      );
      return eventTypeToResource(body.resource);
    }
    const body = await this.#api<{ resource: CalendlyEvent }>(
      context,
      'GET',
      `/scheduled_events/${encodeURIComponent(ref.uuid)}`,
    );
    return eventToResource(body.resource);
  }

  async delete(context: ConnectorContext, id: string): Promise<void> {
    const ref = parseRef(id);
    if (ref.kind !== 'event') {
      throw new ConnectorError('a Calendly event type cannot be deleted', this.id);
    }
    // Cancelling is Calendly's delete for a scheduled event.
    await this.#api(
      context,
      'POST',
      `/scheduled_events/${encodeURIComponent(ref.uuid)}/cancellation`,
      {},
    );
  }

  // --- listing --------------------------------------------------------------

  async #listEventTypes(context: ConnectorContext, options: ListOptions): Promise<ResourcePage> {
    const params = await this.#scopedParams(context, options);
    const body = await this.#api<{ collection?: CalendlyEventType[]; pagination?: Pagination }>(
      context,
      'GET',
      `/event_types?${params.toString()}`,
    );
    return {
      resources: (body.collection ?? []).map(eventTypeToResource),
      nextCursor: body.pagination?.next_page_token ?? null,
    };
  }

  async #listEvents(context: ConnectorContext, options: ListOptions): Promise<ResourcePage> {
    const params = await this.#scopedParams(context, options);
    const body = await this.#api<{ collection?: CalendlyEvent[]; pagination?: Pagination }>(
      context,
      'GET',
      `/scheduled_events?${params.toString()}`,
    );
    return {
      resources: (body.collection ?? []).map(eventToResource),
      nextCursor: body.pagination?.next_page_token ?? null,
    };
  }

  /** Both list endpoints are scoped to a user; resolve it and build the query. */
  async #scopedParams(context: ConnectorContext, options: ListOptions): Promise<URLSearchParams> {
    const params = new URLSearchParams({
      user: await this.#userUri(context),
      count: String(options.limit ?? DEFAULT_LIMIT),
    });
    if (options.cursor) {
      params.set('page_token', options.cursor);
    }
    return params;
  }

  async #userUri(context: ConnectorContext): Promise<string> {
    const body = await this.#api<{ resource?: { uri?: string } }>(context, 'GET', '/users/me');
    const uri = body.resource?.uri;
    if (!uri) {
      throw new ConnectorError('could not resolve the Calendly user', this.id);
    }
    return uri;
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
        `calendly responded ${response.status}: ${text.slice(0, 300)}`,
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
      throw new ConnectorError('calendly connection has no OAuth token', this.id);
    }
    return context.credential.accessToken;
  }
}

// --- translation ------------------------------------------------------------

function eventTypeToResource(eventType: CalendlyEventType): Resource {
  const content = eventType.description_plain ?? null;
  return {
    id: `${EVENT_TYPE_PREFIX}${uuidOf(eventType.uri)}`,
    type: 'event-type',
    title: eventType.name ?? eventType.slug ?? uuidOf(eventType.uri),
    content,
    mimeType: content === null ? null : 'text/plain',
    parentId: null,
    url: eventType.scheduling_url ?? null,
    metadata: {
      uri: eventType.uri,
      ...(eventType.slug ? { slug: eventType.slug } : {}),
      ...(typeof eventType.duration === 'number' ? { duration: eventType.duration } : {}),
      ...(typeof eventType.active === 'boolean' ? { active: eventType.active } : {}),
    },
    createdAt: eventType.created_at ? new Date(eventType.created_at) : null,
    updatedAt: eventType.updated_at ? new Date(eventType.updated_at) : null,
  };
}

function eventToResource(event: CalendlyEvent): Resource {
  return {
    id: `${EVENT_PREFIX}${uuidOf(event.uri)}`,
    type: 'event',
    title: event.name ?? '(scheduled event)',
    content: null,
    mimeType: null,
    parentId: event.event_type ? `${EVENT_TYPE_PREFIX}${uuidOf(event.event_type)}` : null,
    url: event.location?.join_url ?? null,
    metadata: {
      uri: event.uri,
      ...(event.status ? { status: event.status } : {}),
      ...(event.start_time ? { start: event.start_time } : {}),
      ...(event.end_time ? { end: event.end_time } : {}),
      ...(event.location ? { location: event.location } : {}),
    },
    createdAt: event.created_at ? new Date(event.created_at) : null,
    updatedAt: event.updated_at ? new Date(event.updated_at) : null,
  };
}

// --- id helpers -------------------------------------------------------------

/** Calendly identifies a resource by a full URI; the last path segment is its uuid. */
function uuidOf(uri: string): string {
  // Trim any trailing slashes in linear time (no backtracking regex), then take
  // the last path segment.
  let end = uri.length;
  while (end > 0 && uri.charCodeAt(end - 1) === SLASH) end--;
  const trimmed = uri.slice(0, end);
  return trimmed.slice(trimmed.lastIndexOf('/') + 1);
}

function parseRef(id: string): Ref {
  if (id.startsWith(EVENT_TYPE_PREFIX)) {
    const uuid = id.slice(EVENT_TYPE_PREFIX.length);
    if (uuid === '') throw invalidId(id);
    return { kind: 'event-type', uuid };
  }
  if (id.startsWith(EVENT_PREFIX)) {
    const uuid = id.slice(EVENT_PREFIX.length);
    if (uuid === '') throw invalidId(id);
    return { kind: 'event', uuid };
  }
  throw invalidId(id);
}

function invalidId(id: string): ConnectorError {
  return new ConnectorError(
    `invalid Calendly id "${id}"; expected "event-type:<uuid>" or "event:<uuid>"`,
    CONNECTOR_ID,
  );
}
