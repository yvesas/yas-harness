// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The GitHub transport, shared by every resource kind.
 *
 * Two APIs sit behind one connection: REST for issues and repository contents,
 * GraphQL for discussions and Projects v2. Both are here, so a kind says what
 * it wants from GitHub and nothing about how the request is made.
 *
 * That also makes this the one place the credential is read. A kind never sees
 * the token — it hands over a context and gets a parsed body back, which is the
 * connector-level shape of the same rule the connection layer holds above it.
 */

import type { ConnectorContext } from '../connector.js';
import { ConnectorError, ResourceNotFoundError } from '../connector.js';
import { isOAuthToken } from '../oauth.js';

import { GitHubGraphQL, GitHubGraphQLNotFound } from './github-graphql.js';

const GITHUB_API = 'https://api.github.com';
const API_VERSION = '2022-11-28';

export interface GitHubApiOptions {
  readonly connectorId: string;
  readonly fetch?: typeof globalThis.fetch;
  /** Overrides the API base; only for tests. */
  readonly baseUrl?: string;
}

export class GitHubApi {
  readonly #fetch: typeof globalThis.fetch;
  readonly #apiBase: string;
  readonly #graphql: GitHubGraphQL;
  readonly #connectorId: string;

  constructor(options: GitHubApiOptions) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#apiBase = options.baseUrl ?? GITHUB_API;
    this.#connectorId = options.connectorId;
    this.#graphql = new GitHubGraphQL(this.#fetch, options.connectorId, this.#apiBase);
  }

  /** A REST call, with a 404 mapped to a missing resource. */
  async rest<T>(
    context: ConnectorContext,
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const token = this.#accessToken(context);
    const response = await this.#fetch(`${this.#apiBase}${path}`, {
      signal: context.signal ?? null,
      method,
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/vnd.github+json',
        'x-github-api-version': API_VERSION,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });

    if (response.status === 404) {
      throw new ResourceNotFoundError(this.#connectorId, path);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ConnectorError(
        `github responded ${response.status}: ${text.slice(0, 500)}`,
        this.#connectorId,
      );
    }
    return (await response.json()) as T;
  }

  /** A GraphQL call, with NOT_FOUND mapped the same way a REST 404 is. */
  async gql<T>(
    context: ConnectorContext,
    query: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    try {
      return await this.#graphql.query<T>(
        this.#accessToken(context),
        query,
        variables,
        context.signal,
      );
    } catch (error) {
      if (error instanceof GitHubGraphQLNotFound) {
        throw new ResourceNotFoundError(this.#connectorId, error.message);
      }
      throw error;
    }
  }

  #accessToken(context: ConnectorContext): string {
    if (!isOAuthToken(context.credential)) {
      throw new ConnectorError('github connection has no OAuth token', this.#connectorId);
    }
    return context.credential.accessToken;
  }
}
