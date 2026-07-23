// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A connector for Confluence Cloud.
 *
 * The first real source behind the generic contract, and the proof it holds up
 * against a messy API: Confluence pages become resources, its storage-format
 * body becomes content, its cursor pagination becomes a nextCursor, and its
 * read-then-write version rule is hidden inside update. A product registers
 * this and the connection layer does the rest — OAuth, refresh, credential
 * resolution — so the connector only ever receives a working token.
 *
 * Nothing product-domain here: a Confluence page is a document, the same in a
 * language tutor and a CRM. Written against `fetch`; no dependency.
 */

import type {
  Connector,
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

const CONNECTOR_ID = 'confluence';
const ATLASSIAN_API = 'https://api.atlassian.com';
const DEFAULT_LIMIT = 25;

export interface ConfluenceConnectorOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** Overrides the Atlassian API base; only for tests. */
  readonly baseUrl?: string;
}

interface ConfluencePage {
  id: string;
  title: string;
  spaceId?: string;
  parentId?: string | null;
  status?: string;
  body?: { storage?: { value?: string } };
  version?: { number?: number; createdAt?: string };
  createdAt?: string;
  _links?: { webui?: string; base?: string };
}

export class ConfluenceConnector implements Connector {
  readonly id = CONNECTOR_ID;
  readonly description = 'Confluence Cloud spaces and pages.';
  readonly capabilities = ['list', 'read', 'search', 'create', 'update', 'delete'] as const;

  readonly #fetch: typeof globalThis.fetch;
  readonly #apiBase: string;
  /** cloudId is per-connection and discovered at runtime; cache it per call context. */
  readonly #cloudIds = new Map<string, string>();

  constructor(options: ConfluenceConnectorOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiBase = options.baseUrl ?? ATLASSIAN_API;
  }

  async list(context: ConnectorContext, options: ListOptions = {}): Promise<ResourcePage> {
    const query = new URLSearchParams({
      limit: String(options.limit ?? DEFAULT_LIMIT),
      'body-format': 'storage',
    });
    if (options.cursor) {
      query.set('cursor', options.cursor);
    }
    // A parent narrows to that page's children; otherwise, all reachable pages.
    const path = options.parentId
      ? `/wiki/api/v2/pages/${encodeURIComponent(options.parentId)}/children`
      : '/wiki/api/v2/pages';

    const body = await this.#api<{ results?: ConfluencePage[]; _links?: { next?: string } }>(
      context,
      'GET',
      `${path}?${query.toString()}`,
    );
    return {
      resources: (body.results ?? []).map(toResource),
      nextCursor: cursorFromNext(body._links?.next),
    };
  }

  async read(context: ConnectorContext, id: string): Promise<Resource> {
    return toResource(await this.#page(context, id));
  }

  async search(
    context: ConnectorContext,
    query: string,
    options: SearchOptions = {},
  ): Promise<ResourcePage> {
    // Confluence v2 has no text search; CQL through the v1 endpoint is how it
    // is really done. The results are pages, mapped to the same shape.
    const params = new URLSearchParams({
      cql: `text ~ ${JSON.stringify(query)}`,
      limit: String(options.limit ?? DEFAULT_LIMIT),
    });
    if (options.cursor) {
      params.set('cursor', options.cursor);
    }
    const body = await this.#api<{ results?: SearchResult[]; _links?: { next?: string } }>(
      context,
      'GET',
      `/wiki/rest/api/content/search?${params.toString()}`,
    );
    return {
      resources: (body.results ?? []).map(searchResultToResource),
      nextCursor: cursorFromNext(body._links?.next),
    };
  }

  async create(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    const spaceId = draft.metadata?.['spaceId'];
    if (typeof spaceId !== 'string') {
      throw new ConnectorError(
        'creating a Confluence page needs metadata.spaceId (which space it goes in)',
        this.id,
      );
    }

    const created = await this.#api<ConfluencePage>(context, 'POST', '/wiki/api/v2/pages', {
      spaceId,
      status: 'current',
      title: draft.title,
      ...(draft.parentId ? { parentId: draft.parentId } : {}),
      body: { representation: 'storage', value: draft.content ?? '' },
    });
    return toResource(created);
  }

  async update(context: ConnectorContext, id: string, patch: ResourcePatch): Promise<Resource> {
    // Confluence needs the next version number, so read the current page first.
    const current = await this.#page(context, id);
    const nextVersion = (current.version?.number ?? 0) + 1;

    const updated = await this.#api<ConfluencePage>(
      context,
      'PUT',
      `/wiki/api/v2/pages/${encodeURIComponent(id)}`,
      {
        id,
        status: 'current',
        title: patch.title ?? current.title,
        body: {
          representation: 'storage',
          value: patch.content ?? current.body?.storage?.value ?? '',
        },
        version: { number: nextVersion },
      },
    );
    return toResource(updated);
  }

  async delete(context: ConnectorContext, id: string): Promise<void> {
    await this.#api(context, 'DELETE', `/wiki/api/v2/pages/${encodeURIComponent(id)}`);
  }

  async #page(context: ConnectorContext, id: string): Promise<ConfluencePage> {
    return this.#api<ConfluencePage>(
      context,
      'GET',
      `/wiki/api/v2/pages/${encodeURIComponent(id)}?body-format=storage`,
    );
  }

  /** One authenticated call against the connection's Confluence site. */
  async #api<T>(
    context: ConnectorContext,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = this.#accessToken(context);
    const cloudId = await this.#cloudId(context, token);
    const url = `${this.#apiBase}/ex/confluence/${cloudId}${path}`;

    const response = await this.#fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
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
        `confluence responded ${response.status}: ${text.slice(0, 500)}`,
        this.id,
      );
    }
    // DELETE and some updates return no body.
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

  /**
   * The cloudId identifies which Atlassian site this connection points at. It
   * is not in the credential — a refresh would drop it — so it is discovered
   * from the token and cached for the connection's lifetime in this process.
   */
  async #cloudId(context: ConnectorContext, token: string): Promise<string> {
    const cached = this.#cloudIds.get(context.connectionId);
    if (cached) {
      return cached;
    }

    const response = await this.#fetch(`${this.#apiBase}/oauth/token/accessible-resources`, {
      headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
    });
    if (!response.ok) {
      throw new ConnectorError(
        `cannot list accessible Atlassian sites: ${response.status}`,
        this.id,
      );
    }

    const sites = (await response.json()) as { id?: string }[];
    const cloudId = sites[0]?.id;
    if (!cloudId) {
      throw new ConnectorError('the connected account has no accessible Confluence site', this.id);
    }

    this.#cloudIds.set(context.connectionId, cloudId);
    return cloudId;
  }

  #accessToken(context: ConnectorContext): string {
    if (!isOAuthToken(context.credential)) {
      throw new ConnectorError('confluence connection has no OAuth token', this.id);
    }
    return context.credential.accessToken;
  }
}

interface SearchResult {
  id: string;
  title?: string;
  status?: string;
  space?: { id?: string; key?: string };
  _links?: { webui?: string };
}

function toResource(page: ConfluencePage): Resource {
  const content = page.body?.storage?.value;
  return {
    id: page.id,
    type: 'page',
    title: page.title,
    content: content ?? null,
    mimeType: content === undefined ? null : 'text/html',
    parentId: page.parentId ?? null,
    url: page._links?.webui ?? null,
    metadata: {
      ...(page.spaceId ? { spaceId: page.spaceId } : {}),
      ...(page.status ? { status: page.status } : {}),
      ...(page.version?.number ? { version: page.version.number } : {}),
    },
    createdAt: page.createdAt ? new Date(page.createdAt) : null,
    updatedAt: page.version?.createdAt ? new Date(page.version.createdAt) : null,
  };
}

function searchResultToResource(result: SearchResult): Resource {
  return {
    id: result.id,
    type: 'page',
    title: result.title ?? '',
    content: null,
    mimeType: null,
    parentId: null,
    url: result._links?.webui ?? null,
    metadata: {
      ...(result.space?.id ? { spaceId: result.space.id } : {}),
      ...(result.status ? { status: result.status } : {}),
    },
    createdAt: null,
    updatedAt: null,
  };
}

/** Confluence's `_links.next` is a path with a cursor query param; take the cursor. */
function cursorFromNext(next: string | undefined): string | null {
  if (!next) {
    return null;
  }
  const query = next.includes('?') ? next.slice(next.indexOf('?')) : '';
  return new URLSearchParams(query).get('cursor');
}
