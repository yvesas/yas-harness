// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The connector contract: one shape for every external source.
 *
 * Google Drive, Confluence, Notion — they differ in every detail, but they
 * share a shape: named things you can list, read, search, create, edit and
 * delete. A connector translates one source into that shape; the harness (and
 * the products on it) speak only the shape, never a source's API.
 *
 * Nothing here is product domain. A "resource" is a document or a page, not a
 * "customer" or an "invoice" — it would mean the same thing in a language tutor
 * and in a CRM, which is exactly the test for belonging in the harness.
 */

/** What a connector can do. Declared, and each maps to a method below. */
export type ConnectorCapability = 'list' | 'read' | 'search' | 'create' | 'update' | 'delete';

/**
 * A named thing in an external source: a file, a page, a document, a folder.
 *
 * `type` is the connector's own word for what this is; the harness does not
 * enumerate the kinds. `metadata` carries whatever a source has that this
 * shape does not name, so nothing is lost in translation.
 */
export interface Resource {
  readonly id: string;
  /** The connector's own kind, e.g. "file", "page", "folder", "database". */
  readonly type: string;
  readonly title: string;
  /** The body. Null in list/search results; populated by read. */
  readonly content: string | null;
  readonly mimeType: string | null;
  /** The containing resource, if the source is hierarchical. */
  readonly parentId: string | null;
  /** A link a human can open, if the source has one. */
  readonly url: string | null;
  /** Source-specific fields this shape does not name. */
  readonly metadata: Record<string, unknown>;
  readonly createdAt: Date | null;
  readonly updatedAt: Date | null;
}

/** A page of resources, with an opaque cursor for the next one. */
export interface ResourcePage {
  readonly resources: readonly Resource[];
  readonly nextCursor: string | null;
}

/** What to create. `title` is the one thing every source needs. */
export interface ResourceDraft {
  readonly title: string;
  readonly type?: string;
  readonly content?: string;
  readonly mimeType?: string;
  readonly parentId?: string;
  readonly metadata?: Record<string, unknown>;
}

/** What to change on an existing resource. Only the named fields are touched. */
export interface ResourcePatch {
  readonly title?: string;
  readonly content?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface ListOptions {
  /** List within a container; omit for the top level. */
  readonly parentId?: string;
  readonly type?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

export interface SearchOptions {
  readonly cursor?: string;
  readonly limit?: number;
}

/**
 * What a connector is handed for one operation.
 *
 * `credential` is the resolved secret for this connection — the connector uses
 * it to authenticate the outbound call and does nothing else with it. The
 * connection layer resolves it from the vault at call time, so the credential
 * exists in the clear only for the length of the call, and the agent above
 * never sees it.
 */
export interface ConnectorContext {
  readonly tenantId: string;
  readonly connectionId: string;
  readonly credential: unknown;
}

/**
 * A source, behind the common shape.
 *
 * The operation methods are optional; `capabilities` declares which a connector
 * actually implements, and the registry checks the two agree. A source that is
 * read-only simply declares `['list', 'read', 'search']` and implements those.
 */
export interface Connector {
  /** Stable id, e.g. "google-drive". Matches a connection's connectorId. */
  readonly id: string;
  readonly description: string;
  readonly capabilities: readonly ConnectorCapability[];

  list?(context: ConnectorContext, options?: ListOptions): Promise<ResourcePage>;
  read?(context: ConnectorContext, id: string): Promise<Resource>;
  search?(context: ConnectorContext, query: string, options?: SearchOptions): Promise<ResourcePage>;
  create?(context: ConnectorContext, draft: ResourceDraft): Promise<Resource>;
  update?(context: ConnectorContext, id: string, patch: ResourcePatch): Promise<Resource>;
  delete?(context: ConnectorContext, id: string): Promise<void>;
}

export class ConnectorError extends Error {
  constructor(
    message: string,
    readonly connectorId: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'ConnectorError';
  }
}

/** Raised when a resource a connector was asked for does not exist. */
export class ResourceNotFoundError extends ConnectorError {
  constructor(connectorId: string, id: string) {
    super(`resource "${id}" not found`, connectorId);
    this.name = 'ResourceNotFoundError';
  }
}

/** The method each capability requires a connector to implement. */
const CAPABILITY_METHOD: Record<ConnectorCapability, keyof Connector> = {
  list: 'list',
  read: 'read',
  search: 'search',
  create: 'create',
  update: 'update',
  delete: 'delete',
};

/**
 * Check that every capability a connector declares is one it implements.
 *
 * The reverse is allowed on purpose: a connector class may implement more than
 * it exposes — a full connector run in read-only mode still has the write
 * methods, but declares only the read capabilities, and the manager gates on
 * what is declared. What must never happen is the opposite: declaring a
 * capability whose method is missing, which would fail only when the operation
 * is first attempted against a live source. So that is what fails at
 * registration instead.
 */
export function assertConnectorConsistent(connector: Connector): void {
  for (const capability of connector.capabilities) {
    if (typeof connector[CAPABILITY_METHOD[capability]] !== 'function') {
      throw new ConnectorError(
        `connector "${connector.id}" declares "${capability}" but does not implement it`,
        connector.id,
      );
    }
  }
}
