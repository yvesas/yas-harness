// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * From "a person clicked connect" to "a connection with a sealed credential".
 *
 * The harness already had both ends of this. `OAuthClient` knows how to build an
 * authorization URL and trade a code for tokens; `ConnectionStore` and
 * `CredentialVault` know how to record a connection and seal its secret. What
 * was missing was the join — and the absence showed up the moment something
 * actually had to run the flow, which is what the console's Connections page is.
 *
 * The join is small but it is not nothing, because getting it wrong is how a
 * credential ends up somewhere it should not be. Two rules hold here:
 *
 * - **The client secret never leaves.** Callers name a connector; they do not
 *   receive an `OAuthProvider`. Handing one out would put a client secret in
 *   every surface that wanted to render a "connect" button.
 * - **A connection with no credential must not exist.** If sealing fails after
 *   the row is written, the row is removed. A connection that looks connected
 *   and cannot authenticate is worse than no connection: it fails later, at a
 *   call, and reads as the source being down.
 */

import type { ConnectionStore, Connection } from './connection-store.js';
import type { CredentialVault } from './credential-vault.js';
import type { OAuthClient, OAuthProvider } from './oauth.js';
import { OAuthError } from './oauth.js';

export interface AuthorizationRequest {
  /** Where the provider sends the browser back. Must match at the token step. */
  readonly redirectUri: string;
  /**
   * Opaque to the harness: the product mints it, keeps it, and checks it on the
   * callback. It is what stops a crafted callback attaching somebody else's
   * account to this tenant.
   */
  readonly state: string;
}

export interface CompleteRequest {
  readonly tenantId: string;
  readonly code: string;
  /** The same value sent to the authorization endpoint; providers compare it. */
  readonly redirectUri: string;
  /** How a person will recognise this connection in a list. */
  readonly accountLabel?: string;
}

/** Raised when a connector has no OAuth provider configured. */
export class UnknownProviderError extends Error {
  constructor(connectorId: string) {
    super(
      `no OAuth provider configured for "${connectorId}". Add it to ` +
        'config/connectors.json, with its client id and secret in the environment.',
    );
    this.name = 'UnknownProviderError';
  }
}

export class ConnectionOnboarding {
  readonly #providers: ReadonlyMap<string, OAuthProvider>;
  readonly #client: OAuthClient;
  readonly #connections: ConnectionStore;
  readonly #vault: CredentialVault;

  constructor(
    providers: ReadonlyMap<string, OAuthProvider>,
    client: OAuthClient,
    connections: ConnectionStore,
    vault: CredentialVault,
  ) {
    this.#providers = providers;
    this.#client = client;
    this.#connections = connections;
    this.#vault = vault;
  }

  /** Which connectors can be connected through a browser. */
  connectable(): string[] {
    return [...this.#providers.keys()].sort();
  }

  /** What scopes this connector will ask a person to grant. */
  scopesFor(connectorId: string): readonly string[] {
    return this.#provider(connectorId).scopes;
  }

  /** Where to send the browser. */
  authorizationUrl(connectorId: string, request: AuthorizationRequest): string {
    return this.#client.buildAuthorizationUrl(this.#provider(connectorId), request);
  }

  /**
   * Trade the code, record the connection, seal the credential.
   *
   * Returns the connection. The token is never returned — the only way back to
   * it is the vault, at call time, which is what "the agent never sees API
   * keys" means in practice.
   */
  async complete(connectorId: string, request: CompleteRequest): Promise<Connection> {
    const provider = this.#provider(connectorId);
    const token = await this.#client.exchangeCode(
      provider,
      { code: request.code, redirectUri: request.redirectUri },
      connectorId,
    );

    // The scopes the provider actually granted, which are not always the ones
    // asked for — a person can decline part of a consent screen.
    const granted = grantedScopes(token.scope);

    const connection = await this.#connections.create({
      tenantId: request.tenantId,
      connectorId,
      ...(request.accountLabel === undefined ? {} : { accountLabel: request.accountLabel }),
      ...(granted && granted.length > 0 ? { scopes: granted } : { scopes: provider.scopes }),
    });

    try {
      await this.#vault.store(request.tenantId, connection.id, token);
    } catch (error) {
      // Undo the row. A connection that looks connected and cannot authenticate
      // fails later, at a call, and reads as the source being down.
      await this.#connections.remove(request.tenantId, connection.id).catch(() => undefined);
      throw new OAuthError(
        `connected to "${connectorId}" but could not store the credential, so the connection was undone`,
        { provider: connectorId, retryable: false },
        { cause: error },
      );
    }

    return connection;
  }

  #provider(connectorId: string): OAuthProvider {
    const provider = this.#providers.get(connectorId);
    if (!provider) {
      throw new UnknownProviderError(connectorId);
    }
    return provider;
  }
}

/**
 * The scopes a provider says it granted, however it chose to delimit them.
 *
 * RFC 6749 §3.3 says space-separated, and GitHub answers with commas. Splitting
 * on the specification alone produced a single scope named
 * `"public_repo,read:user"` — one string that looks right on a page and is
 * wrong in every comparison, which is the worst way for data to be wrong.
 *
 * So both, since neither is a legal character *inside* a scope: RFC 6749 draws
 * scope tokens from a character set that excludes the space and the comma
 * alike. Splitting on either can therefore only ever separate scopes, never cut
 * one in half.
 */
export function grantedScopes(scope: string | null | undefined): string[] {
  return (scope ?? '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter(Boolean);
}
