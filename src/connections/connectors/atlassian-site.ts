// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The plumbing every Atlassian connector shares.
 *
 * Confluence and Jira Cloud both authenticate the same way: an OAuth 3LO token,
 * a `cloudId` that names the site (discovered from the token, not stored — a
 * refresh would drop it), and calls to `api.atlassian.com/ex/{product}/{cloudId}`.
 * This holds that so a connector only writes the part that is actually its
 * source: the endpoints and the translation.
 */

import { ConnectorError } from '../connector.js';
import type { ConnectorContext } from '../connector.js';
import { isOAuthToken } from '../oauth.js';

const ATLASSIAN_API = 'https://api.atlassian.com';

export interface AtlassianSiteOptions {
  /** The connector using this, for error messages. */
  readonly connectorId: string;
  /** `confluence` or `jira` — the product segment of the ex/ path. */
  readonly product: 'confluence' | 'jira';
  readonly fetch: typeof globalThis.fetch;
  /** Overrides the Atlassian API base; only for tests. */
  readonly baseUrl?: string;
}

/** Raised, and returned, when a request 404s, so a connector maps it to not-found. */
export class AtlassianNotFound extends Error {
  constructor() {
    super('not found');
    this.name = 'AtlassianNotFound';
  }
}

export class AtlassianSite {
  readonly #connectorId: string;
  readonly #product: string;
  readonly #fetch: typeof globalThis.fetch;
  readonly #apiBase: string;
  /** cloudId is per-connection; discovered from the token and cached. */
  readonly #cloudIds = new Map<string, string>();

  constructor(options: AtlassianSiteOptions) {
    this.#connectorId = options.connectorId;
    this.#product = options.product;
    this.#fetch = options.fetch;
    this.#apiBase = options.baseUrl ?? ATLASSIAN_API;
  }

  /**
   * One authenticated call against the connection's site. Returns undefined on
   * 204; throws AtlassianNotFound on 404 so the caller decides what "not found"
   * means for its resource type.
   */
  async request<T>(
    context: ConnectorContext,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = this.#accessToken(context);
    const cloudId = await this.#cloudId(context, token);
    const url = `${this.#apiBase}/ex/${this.#product}/${cloudId}${path}`;

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
      throw new AtlassianNotFound();
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ConnectorError(
        `${this.#product} responded ${response.status}: ${text.slice(0, 500)}`,
        this.#connectorId,
      );
    }
    if (response.status === 204) {
      return undefined as T;
    }
    return (await response.json()) as T;
  }

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
        this.#connectorId,
      );
    }

    const sites = (await response.json()) as { id?: string }[];
    const cloudId = sites[0]?.id;
    if (!cloudId) {
      throw new ConnectorError(
        `the connected account has no accessible ${this.#product} site`,
        this.#connectorId,
      );
    }

    this.#cloudIds.set(context.connectionId, cloudId);
    return cloudId;
  }

  #accessToken(context: ConnectorContext): string {
    if (!isOAuthToken(context.credential)) {
      throw new ConnectorError(`${this.#product} connection has no OAuth token`, this.#connectorId);
    }
    return context.credential.accessToken;
  }
}
