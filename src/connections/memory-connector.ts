// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A connector backed by process memory.
 *
 * It implements the whole contract — list, read, search, create, update,
 * delete — over an in-memory store. Two uses: it is the double the connection
 * layer is tested against, and it is the worked example of what a real
 * connector must do. A product building a Drive or Notion connector can read
 * this to see the shape it has to fill.
 *
 * It also demonstrates the credential boundary: it refuses to run without a
 * credential in its context, exactly as a real connector would need one to
 * authenticate — but of course never sends it anywhere.
 */

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
import { ConnectorError, ResourceNotFoundError } from './connector.js';

// The operations do no real I/O, but they are async to match the Connector
// contract (real connectors await network calls) and so a failed precondition
// rejects rather than throwing synchronously.
/* eslint-disable @typescript-eslint/require-await */

const DEFAULT_LIMIT = 50;

interface StoredResource extends Resource {
  /** Isolates one connection's resources from another's within the fake. */
  readonly connectionId: string;
}

export interface MemoryConnectorOptions {
  readonly id?: string;
  readonly description?: string;
  /** Restrict the capabilities, to model a read-only source in a test. */
  readonly capabilities?: readonly ConnectorCapability[];
}

export class MemoryConnector implements Connector {
  readonly id: string;
  readonly description: string;
  readonly capabilities: readonly ConnectorCapability[];

  readonly #resources = new Map<string, StoredResource>();
  #counter = 0;

  constructor(options: MemoryConnectorOptions = {}) {
    this.id = options.id ?? 'memory';
    this.description = options.description ?? 'In-memory connector for tests and reference.';
    this.capabilities = options.capabilities ?? [
      'list',
      'read',
      'search',
      'create',
      'update',
      'delete',
    ];
  }

  async list(context: ConnectorContext, options: ListOptions = {}): Promise<ResourcePage> {
    this.#requireCredential(context);
    const all = this.#scoped(context)
      .filter((r) => options.parentId === undefined || r.parentId === options.parentId)
      .filter((r) => options.type === undefined || r.type === options.type)
      .sort((a, b) => a.id.localeCompare(b.id));

    return this.#paginate(all, options.cursor, options.limit);
  }

  async read(context: ConnectorContext, id: string): Promise<Resource> {
    this.#requireCredential(context);
    return strip(this.#require(context, id));
  }

  async search(
    context: ConnectorContext,
    query: string,
    options: SearchOptions = {},
  ): Promise<ResourcePage> {
    this.#requireCredential(context);
    const needle = query.toLowerCase();
    const matches = this.#scoped(context)
      .filter(
        (r) =>
          r.title.toLowerCase().includes(needle) ||
          (r.content ?? '').toLowerCase().includes(needle),
      )
      .sort((a, b) => a.id.localeCompare(b.id));

    return this.#paginate(matches, options.cursor, options.limit);
  }

  async create(context: ConnectorContext, draft: ResourceDraft): Promise<Resource> {
    this.#requireCredential(context);
    this.#counter += 1;
    const now = new Date(this.#counter * 1000);
    const resource: StoredResource = {
      connectionId: context.connectionId,
      id: `res-${this.#counter}`,
      type: draft.type ?? 'document',
      title: draft.title,
      content: draft.content ?? null,
      mimeType: draft.mimeType ?? null,
      parentId: draft.parentId ?? null,
      url: null,
      metadata: draft.metadata ?? {},
      createdAt: now,
      updatedAt: now,
    };
    this.#resources.set(this.#key(context, resource.id), resource);
    return strip(resource);
  }

  async update(context: ConnectorContext, id: string, patch: ResourcePatch): Promise<Resource> {
    this.#requireCredential(context);
    const current = this.#require(context, id);
    this.#counter += 1;
    const updated: StoredResource = {
      ...current,
      title: patch.title ?? current.title,
      content: patch.content ?? current.content,
      metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
      updatedAt: new Date(this.#counter * 1000),
    };
    this.#resources.set(this.#key(context, id), updated);
    return strip(updated);
  }

  async delete(context: ConnectorContext, id: string): Promise<void> {
    this.#requireCredential(context);
    if (!this.#resources.delete(this.#key(context, id))) {
      throw new ResourceNotFoundError(this.id, id);
    }
  }

  #scoped(context: ConnectorContext): StoredResource[] {
    return [...this.#resources.values()].filter((r) => r.connectionId === context.connectionId);
  }

  #require(context: ConnectorContext, id: string): StoredResource {
    const resource = this.#resources.get(this.#key(context, id));
    if (!resource) {
      throw new ResourceNotFoundError(this.id, id);
    }
    return resource;
  }

  #paginate(
    all: StoredResource[],
    cursor: string | undefined,
    limit = DEFAULT_LIMIT,
  ): ResourcePage {
    const start = cursor ? Number(cursor) : 0;
    const slice = all.slice(start, start + limit);
    const next = start + limit;
    return {
      resources: slice.map(strip),
      nextCursor: next < all.length ? String(next) : null,
    };
  }

  #key(context: ConnectorContext, id: string): string {
    return `${context.connectionId}/${id}`;
  }

  #requireCredential(context: ConnectorContext): void {
    // A real connector needs a credential to authenticate; the fake enforces
    // the same precondition so a test that forgets it fails loudly.
    if (context.credential === null || context.credential === undefined) {
      throw new ConnectorError(`connector "${this.id}" was given no credential`, this.id);
    }
  }
}

function strip(resource: StoredResource): Resource {
  const { connectionId: _connectionId, ...rest } = resource;
  return rest;
}
