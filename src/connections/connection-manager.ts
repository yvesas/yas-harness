// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The connection manager: run an operation against a tenant's connection.
 *
 * This is the seam where the three pieces meet. Given a tenant and a
 * connection, it finds the connection record, resolves its credential from the
 * vault, picks the connector, checks the operation is one the connector
 * supports, and runs it — handing the connector the credential only for the
 * length of the call.
 *
 * The credential lives in the clear on this stack and nowhere else. It is not
 * returned, not logged, not passed upward. That is the concrete meaning of
 * "the agent never sees API keys": the agent asks the manager to read or edit
 * a resource, and gets back the resource.
 */

import type { ConnectionStore } from './connection-store.js';
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
} from './connector.js';
import { ConnectorError, ConnectorTimeoutError } from './connector.js';
import type { ConnectorRegistry } from './connector-registry.js';
import type { Connection } from './connection-store.js';
import type { CredentialResolver } from './credential-resolver.js';
import { OAuthRefreshError } from './oauth-token-refresher.js';

export class ConnectionManagerError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ConnectionManagerError';
  }
}

/** How long an external source gets before the call is abandoned. */
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export interface ConnectionManagerOptions {
  /**
   * Deadline for one connector call, in milliseconds. Defaults to 30s.
   *
   * The deadline is set here rather than in each connector on purpose: how long
   * a source may take is policy, and policy belongs to the caller. A connector
   * only has to honour the signal it is handed.
   */
  readonly requestTimeoutMs?: number;
}

export class ConnectionManager {
  readonly #connectors: ConnectorRegistry;
  readonly #connections: ConnectionStore;
  readonly #resolver: CredentialResolver;
  readonly #requestTimeoutMs: number;

  constructor(
    connectors: ConnectorRegistry,
    connections: ConnectionStore,
    resolver: CredentialResolver,
    options: ConnectionManagerOptions = {},
  ) {
    this.#connectors = connectors;
    this.#connections = connections;
    this.#resolver = resolver;
    this.#requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  }

  list(tenantId: string, connectionId: string, options?: ListOptions): Promise<ResourcePage> {
    return this.#run(tenantId, connectionId, 'list', (connector, ctx) =>
      connector.list!(ctx, options),
    );
  }

  read(tenantId: string, connectionId: string, id: string): Promise<Resource> {
    return this.#run(tenantId, connectionId, 'read', (connector, ctx) => connector.read!(ctx, id));
  }

  search(
    tenantId: string,
    connectionId: string,
    query: string,
    options?: SearchOptions,
  ): Promise<ResourcePage> {
    return this.#run(tenantId, connectionId, 'search', (connector, ctx) =>
      connector.search!(ctx, query, options),
    );
  }

  create(tenantId: string, connectionId: string, draft: ResourceDraft): Promise<Resource> {
    return this.#run(tenantId, connectionId, 'create', (connector, ctx) =>
      connector.create!(ctx, draft),
    );
  }

  update(
    tenantId: string,
    connectionId: string,
    id: string,
    patch: ResourcePatch,
  ): Promise<Resource> {
    return this.#run(tenantId, connectionId, 'update', (connector, ctx) =>
      connector.update!(ctx, id, patch),
    );
  }

  delete(tenantId: string, connectionId: string, id: string): Promise<void> {
    return this.#run(tenantId, connectionId, 'delete', (connector, ctx) =>
      connector.delete!(ctx, id),
    );
  }

  async #run<T>(
    tenantId: string,
    connectionId: string,
    capability: ConnectorCapability,
    operation: (connector: Connector, context: ConnectorContext) => Promise<T>,
  ): Promise<T> {
    const connection = await this.#connections.find(tenantId, connectionId);
    if (!connection) {
      throw new ConnectionManagerError(
        `connection "${connectionId}" not found for tenant "${tenantId}"`,
      );
    }
    // A revoked, expired or errored connection must not be used. A merely
    // stale OAuth token does not put a connection here — it stays active and
    // the resolver refreshes it below; a connection reaches 'expired' only when
    // a refresh has actually failed and re-authorisation is needed.
    if (connection.status !== 'active') {
      throw new ConnectionManagerError(
        `connection "${connectionId}" is ${connection.status}, not active`,
      );
    }

    const connector = this.#connectors.get(connection.connectorId);
    if (!connector) {
      throw new ConnectionManagerError(`no connector registered for "${connection.connectorId}"`);
    }
    if (!connector.capabilities.includes(capability)) {
      throw new ConnectorError(
        `connector "${connector.id}" does not support "${capability}"`,
        connector.id,
      );
    }

    const credential = await this.#resolve(connection);
    if (credential === null) {
      throw new ConnectionManagerError(`connection "${connectionId}" has no stored credential`);
    }

    // The deadline starts here, after the credential is resolved: a slow token
    // refresh is a different failure from a slow source, and charging the
    // refresh against the source's budget would report the wrong one.
    const signal = AbortSignal.timeout(this.#requestTimeoutMs);
    const context: ConnectorContext = { tenantId, connectionId, credential, signal };

    try {
      return await operation(connector, context);
    } catch (error) {
      // A connector that honoured the signal throws whatever `fetch` throws on
      // abort — a bare DOMException that says nothing about which source stopped
      // answering. Give it a name a trace can act on.
      if (isAbort(error)) {
        throw new ConnectorTimeoutError(connector.id, capability, this.#requestTimeoutMs, {
          cause: error,
        });
      }
      throw error;
    }
  }

  /**
   * Resolve the credential, refreshing a stale OAuth token transparently. A
   * refresh that fails outright downgrades the connection to 'expired' — the
   * user must re-authorise — so the same call is not retried into the ground.
   */
  async #resolve(connection: Connection): Promise<unknown> {
    try {
      return await this.#resolver.resolve(connection);
    } catch (error) {
      if (error instanceof OAuthRefreshError) {
        await this.#connections.setStatus(connection.tenantId, connection.id, 'expired');
        throw new ConnectionManagerError(
          `connection "${connection.id}" needs re-authorisation: ${error.message}`,
          { cause: error },
        );
      }
      throw error;
    }
  }
}

/**
 * Whether a failure is the deadline firing rather than the source answering.
 *
 * Matched on `name`, not on class: `AbortSignal.timeout` raises a
 * `TimeoutError` and an explicit abort raises an `AbortError`, and which of the
 * two surfaces depends on the fetch implementation. Both mean the same thing
 * here — the call was cut short, not answered.
 */
function isAbort(error: unknown): boolean {
  return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}
