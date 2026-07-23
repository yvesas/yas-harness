// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * OAuth 2.0 authorization-code mechanics, one shape for every provider.
 *
 * Google, Atlassian (Confluence) and Notion differ only in their endpoints,
 * scopes and a few extra params — the protocol is the same. This file does the
 * protocol; a provider is declared as configuration (see `oauth-config.ts`).
 *
 * The harness does the mechanics — build the authorization URL, exchange the
 * code, refresh the token — but not the web endpoints that a user's browser
 * hits. Redirecting the user and receiving the callback is a product's job, the
 * same boundary as approval: the harness gives the pieces, the product wires
 * the channel. Written against `fetch`; no dependency.
 */

/** What is stored in the vault for an OAuth connection. */
export interface OAuthToken {
  readonly accessToken: string;
  /** Present when the provider grants offline access; used to refresh. */
  readonly refreshToken: string | null;
  readonly tokenType: string;
  /** ISO 8601, or null when the token does not expire. */
  readonly expiresAt: string | null;
  /** Space-separated scopes the token actually carries, as the provider reports. */
  readonly scope: string | null;
}

/** A provider's OAuth endpoints and client, resolved (secret included). */
export interface OAuthProvider {
  readonly authorizationEndpoint: string;
  readonly tokenEndpoint: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly scopes: readonly string[];
  /** Extra query params some providers require on the authorization URL. */
  readonly authorizationParams?: Readonly<Record<string, string>>;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly detail: {
      readonly provider: string;
      /** True for transport faults and 5xx — worth another attempt. */
      readonly retryable: boolean;
    },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'OAuthError';
  }
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

export interface OAuthClientOptions {
  readonly fetch?: typeof globalThis.fetch;
  /** Injected so expiry maths is testable; defaults to the wall clock. */
  readonly now?: () => Date;
}

export class OAuthClient {
  readonly #fetch: typeof globalThis.fetch;
  readonly #now: () => Date;

  constructor(options: OAuthClientOptions = {}) {
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#now = options.now ?? (() => new Date());
  }

  /**
   * The URL to send a user to so they authorise the connection.
   *
   * `state` is opaque to the harness — a product mints it, keeps it, and checks
   * it on the callback to defend against CSRF.
   */
  buildAuthorizationUrl(
    provider: OAuthProvider,
    params: { readonly redirectUri: string; readonly state: string },
  ): string {
    const url = new URL(provider.authorizationEndpoint);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', provider.clientId);
    url.searchParams.set('redirect_uri', params.redirectUri);
    url.searchParams.set('scope', provider.scopes.join(' '));
    url.searchParams.set('state', params.state);
    for (const [key, value] of Object.entries(provider.authorizationParams ?? {})) {
      url.searchParams.set(key, value);
    }
    return url.toString();
  }

  /** Trade an authorization code for tokens. */
  exchangeCode(
    provider: OAuthProvider,
    params: { readonly code: string; readonly redirectUri: string },
    providerId = 'oauth',
  ): Promise<OAuthToken> {
    return this.#token(provider, providerId, {
      grant_type: 'authorization_code',
      code: params.code,
      redirect_uri: params.redirectUri,
    });
  }

  /**
   * Get a fresh token from a refresh token.
   *
   * Providers often omit a new refresh token on refresh; the old one is kept so
   * the connection stays refreshable.
   */
  async refresh(
    provider: OAuthProvider,
    refreshToken: string,
    providerId = 'oauth',
  ): Promise<OAuthToken> {
    const token = await this.#token(provider, providerId, {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
    });
    return token.refreshToken ? token : { ...token, refreshToken };
  }

  async #token(
    provider: OAuthProvider,
    providerId: string,
    grant: Record<string, string>,
  ): Promise<OAuthToken> {
    const body = new URLSearchParams({
      ...grant,
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
    });

    let response: Response;
    try {
      response = await this.#fetch(provider.tokenEndpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          accept: 'application/json',
        },
        body,
      });
    } catch (error) {
      throw new OAuthError(`token request failed: ${message(error)}`, {
        provider: providerId,
        retryable: true,
      });
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new OAuthError(`token endpoint responded ${response.status}: ${text.slice(0, 500)}`, {
        provider: providerId,
        retryable: RETRYABLE_STATUS.has(response.status),
      });
    }

    return this.#parse(await response.json(), providerId);
  }

  #parse(payload: unknown, providerId: string): OAuthToken {
    const data = payload as {
      access_token?: unknown;
      refresh_token?: unknown;
      token_type?: unknown;
      expires_in?: unknown;
      scope?: unknown;
    };

    if (typeof data.access_token !== 'string') {
      throw new OAuthError('token response has no access_token', {
        provider: providerId,
        retryable: false,
      });
    }

    const expiresAt =
      typeof data.expires_in === 'number'
        ? new Date(this.#now().getTime() + data.expires_in * 1000).toISOString()
        : null;

    return {
      accessToken: data.access_token,
      refreshToken: typeof data.refresh_token === 'string' ? data.refresh_token : null,
      tokenType: typeof data.token_type === 'string' ? data.token_type : 'Bearer',
      expiresAt,
      scope: typeof data.scope === 'string' ? data.scope : null,
    };
  }
}

/** Whether a token is expired, or within `skewSeconds` of it. */
export function isTokenExpired(token: OAuthToken, now: Date, skewSeconds = 60): boolean {
  if (token.expiresAt === null) {
    return false;
  }
  const expiry = new Date(token.expiresAt).getTime();
  return now.getTime() >= expiry - skewSeconds * 1000;
}

/** A structural check: is this stored credential an OAuth token? */
export function isOAuthToken(value: unknown): value is OAuthToken {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { accessToken?: unknown }).accessToken === 'string'
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
