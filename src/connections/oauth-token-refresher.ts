// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Resolve a connection's OAuth token, refreshing it if it has expired.
 *
 * This is where the refresh is transparent: the manager asks for the
 * credential, and if the stored access token is past (or near) its expiry, this
 * refreshes it against the provider, stores the new token, and returns it. The
 * connector — and the agent above it — only ever sees a working token.
 *
 * A connector with no provider config is not OAuth-managed; its stored
 * credential (a static API key, say) is returned unchanged.
 */

import type { Connection } from './connection-store.js';
import type { CredentialResolver } from './credential-resolver.js';
import type { CredentialVault } from './credential-vault.js';
import type { OAuthClient, OAuthProvider } from './oauth.js';
import { isOAuthToken, isTokenExpired } from './oauth.js';

/** Raised when a token is expired and cannot be refreshed. The manager acts on it. */
export class OAuthRefreshError extends Error {
  constructor(
    message: string,
    readonly detail: { readonly connectionId: string; readonly retryable: boolean },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'OAuthRefreshError';
  }
}

export interface OAuthTokenRefresherOptions {
  /** Refresh this many seconds before actual expiry, to avoid racing it. */
  readonly skewSeconds?: number;
  readonly now?: () => Date;
}

export class OAuthTokenRefresher implements CredentialResolver {
  readonly #vault: CredentialVault;
  readonly #client: OAuthClient;
  readonly #providers: Map<string, OAuthProvider>;
  readonly #skewSeconds: number;
  readonly #now: () => Date;

  constructor(
    vault: CredentialVault,
    client: OAuthClient,
    /** Keyed by connector id — the same key a connection's connectorId uses. */
    providers: Map<string, OAuthProvider>,
    options: OAuthTokenRefresherOptions = {},
  ) {
    this.#vault = vault;
    this.#client = client;
    this.#providers = providers;
    this.#skewSeconds = options.skewSeconds ?? 60;
    this.#now = options.now ?? (() => new Date());
  }

  async resolve(connection: Connection): Promise<unknown> {
    const stored = await this.#vault.resolve(connection.tenantId, connection.id);
    if (stored === null) {
      return null;
    }

    const provider = this.#providers.get(connection.connectorId);
    // Not an OAuth-managed connector, or the stored secret is not a token:
    // hand it back untouched.
    if (!provider || !isOAuthToken(stored)) {
      return stored;
    }

    if (!isTokenExpired(stored, this.#now(), this.#skewSeconds)) {
      return stored;
    }

    if (stored.refreshToken === null) {
      // Expired and nothing to refresh with — the user must re-authorise.
      throw new OAuthRefreshError(
        `token for connection "${connection.id}" is expired and has no refresh token`,
        { connectionId: connection.id, retryable: false },
      );
    }

    let refreshed;
    try {
      refreshed = await this.#client.refresh(provider, stored.refreshToken, connection.connectorId);
    } catch (error) {
      const retryable =
        typeof error === 'object' &&
        error !== null &&
        (error as { detail?: { retryable?: boolean } }).detail?.retryable === true;
      throw new OAuthRefreshError(
        `failed to refresh token for connection "${connection.id}"`,
        { connectionId: connection.id, retryable },
        { cause: error },
      );
    }

    await this.#vault.store(connection.tenantId, connection.id, refreshed);
    return refreshed;
  }
}
