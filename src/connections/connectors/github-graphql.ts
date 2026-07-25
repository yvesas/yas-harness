// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A minimal GitHub GraphQL client.
 *
 * Issues are REST; discussions and projects are GitHub's GraphQL API. This is
 * the thin transport for the GraphQL side — post a query with variables, unwrap
 * `data`, and turn `errors` into a typed failure. No dependency: it is one
 * `fetch` call and a shape check.
 */

import { ConnectorError } from '../connector.js';

const GITHUB_API = 'https://api.github.com';

interface GraphQLResponse<T> {
  data?: T;
  errors?: { type?: string; message?: string }[];
}

export class GitHubGraphQL {
  constructor(
    private readonly fetch: typeof globalThis.fetch,
    private readonly connectorId: string,
    private readonly baseUrl: string = GITHUB_API,
  ) {}

  async query<T>(token: string, query: string, variables: Record<string, unknown>): Promise<T> {
    const response = await this.fetch(`${this.baseUrl}/graphql`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        accept: 'application/json',
        'content-type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ConnectorError(
        `github graphql responded ${response.status}: ${text.slice(0, 500)}`,
        this.connectorId,
      );
    }

    const body = (await response.json()) as GraphQLResponse<T>;
    if (body.errors && body.errors.length > 0) {
      // A NOT_FOUND error is surfaced as its own signal so the connector can map
      // it to a not-found resource, like a REST 404.
      if (body.errors.some((error) => error.type === 'NOT_FOUND')) {
        throw new GitHubGraphQLNotFound(body.errors[0]?.message ?? 'not found');
      }
      throw new ConnectorError(
        `github graphql error: ${body.errors.map((error) => error.message).join('; ')}`,
        this.connectorId,
      );
    }
    if (body.data === undefined) {
      throw new ConnectorError('github graphql returned no data', this.connectorId);
    }
    return body.data;
  }
}

/** Raised on a GraphQL NOT_FOUND, so a connector maps it to a missing resource. */
export class GitHubGraphQLNotFound extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitHubGraphQLNotFound';
  }
}
