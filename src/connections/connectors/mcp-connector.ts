// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Somebody else's MCP server, behind the connector shape.
 *
 * The mirror of `src/mcp/mcp-server.ts`: that one lets an MCP client reach our
 * connectors, this one lets our agent reach an MCP server. Both sit on the same
 * `Resource` vocabulary, which is why either direction is a translation rather
 * than a new concept.
 *
 * It declares **`list` and `read`, and nothing else** — those are the two things
 * MCP's resource primitive actually offers. There is no resource search in the
 * protocol and no create, update or delete, so none is declared: a connector
 * that claims a capability it cannot honour fails at the first live call, which
 * is exactly what the registry's check exists to prevent. A server that exposes
 * writing does so as *tools*, which is a different surface and a different
 * decision — the one MCP.4 is about.
 *
 * ## Two things this gets deliberately right
 *
 * **A session belongs to one tenant.** MCP is stateful: `initialize` opens a
 * session with one tenant's credential, and a Streamable HTTP server hands back
 * an id that carries it. The cache is keyed by tenant *and* connection, so a
 * second tenant reaching the same server opens its own session. Keying by
 * server alone would hand tenant B a handle authorised as tenant A — the leak
 * this codebase spends a schema constraint preventing everywhere else.
 *
 * **The credential stays the vault's.** Nothing is stored here. Each call takes
 * the resolved secret from its `ConnectorContext`, hands it to the transport for
 * that request, and forgets it — the same contract every other connector has,
 * and what keeps OAuth and envelope encryption the source of truth.
 */

import {
  McpClient,
  type McpCallContext,
  type McpResource,
  type McpSession,
  type McpTransport,
} from '../../mcp/mcp-client.js';
import {
  ConnectorError,
  type Connector,
  type ConnectorCapability,
  type ConnectorContext,
  type ListOptions,
  type Resource,
  type ResourcePage,
} from '../connector.js';

/** MCP resources are a flat namespace: no parent, and no timestamps. */
const MCP_CAPABILITIES: readonly ConnectorCapability[] = ['list', 'read'];

export interface McpConnectorOptions {
  /**
   * The connector id, matching a connection's `connectorId`. Prefixed `mcp-` by
   * convention so it is obvious in a trace where a resource came from.
   */
  readonly id?: string;
  readonly description?: string;
  /**
   * How many sessions to keep. Default 256.
   *
   * One per tenant per connection, so a busy multi-tenant deployment would
   * otherwise grow this map for the life of the process. Re-opening a session
   * is one round trip, which is the cheaper of the two problems.
   */
  readonly maxSessions?: number;
  readonly client?: McpClient;
}

const DEFAULT_MAX_SESSIONS = 256;

export class McpConnector implements Connector {
  readonly id: string;
  readonly description: string;
  readonly capabilities = MCP_CAPABILITIES;

  readonly #client: McpClient;
  /** Keyed by tenant **and** connection. Never by server. */
  readonly #sessions = new Map<string, McpSession>();
  readonly #maxSessions: number;

  constructor(transport: McpTransport, options: McpConnectorOptions = {}) {
    this.id = options.id ?? 'mcp';
    this.description = options.description ?? 'Resources from an MCP server';
    this.#client = options.client ?? new McpClient(transport);
    this.#maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  }

  async list(context: ConnectorContext, options: ListOptions = {}): Promise<ResourcePage> {
    const call = await this.#session(context);
    const page = await this.#client.listResources(
      call,
      options.cursor === undefined ? {} : { cursor: options.cursor },
    );

    let resources = page.resources.map((entry) => toResource(entry, null));
    if (options.type !== undefined) {
      // MCP has no notion of a type, so the closest honest reading of the
      // filter is the mime type. Filtered here rather than ignored: silently
      // returning everything would look like the source has no types at all.
      resources = resources.filter((resource) => resource.mimeType === options.type);
    }
    if (options.limit !== undefined) {
      resources = resources.slice(0, options.limit);
    }

    return { resources, nextCursor: page.nextCursor };
  }

  async read(context: ConnectorContext, id: string): Promise<Resource> {
    const call = await this.#session(context);
    const contents = await this.#client.readResource(call, id);
    if (contents.length === 0) {
      throw new ConnectorError(`MCP server returned no contents for "${id}"`, this.id);
    }

    // Text parts joined; a binary part contributes its type and nothing else.
    // Base64 in a model's context is tokens spent on noise.
    const text = contents
      .map((part) => part.text)
      .filter((part): part is string => part !== undefined)
      .join('\n\n');

    return toResource(
      { uri: id, ...pickDefined('mimeType', contents[0]?.mimeType) },
      text.length > 0 ? text : null,
    );
  }

  /**
   * The session for this tenant and connection, opened if there is not one.
   *
   * A tenant's own id is part of the key, not decoration: it is what stops one
   * tenant being handed a session opened with another's credential.
   */
  async #session(context: ConnectorContext): Promise<McpCallContext> {
    const key = `${context.tenantId}:${context.connectionId}`;
    const call: McpCallContext = {
      credential: context.credential,
      ...(context.signal ? { signal: context.signal } : {}),
    };

    const known = this.#sessions.get(key);
    if (known) {
      return { ...call, ...pickDefined('sessionId', known.sessionId) };
    }

    const session = await this.#client.initialize(call);
    if (!session.supportsResources) {
      // Said plainly at the handshake rather than as a bare "method not found"
      // on the first list: the answer is to connect a different server.
      throw new ConnectorError(
        `MCP server "${session.serverName}" exposes no resources, so there is nothing to list or read`,
        this.id,
      );
    }

    if (this.#sessions.size >= this.#maxSessions) {
      // Oldest out. Insertion order is a Map guarantee, and a re-handshake is
      // one round trip.
      const oldest = this.#sessions.keys().next();
      if (!oldest.done) {
        this.#sessions.delete(oldest.value);
      }
    }
    this.#sessions.set(key, session);

    return { ...call, ...pickDefined('sessionId', session.sessionId) };
  }
}

/** An `http(s)` uri is a link a human can open; anything else is an id only. */
function openableUrl(uri: string): string | null {
  return uri.startsWith('http://') || uri.startsWith('https://') ? uri : null;
}

function toResource(entry: McpResource, content: string | null): Resource {
  return {
    id: entry.uri,
    // MCP does not classify a resource, and inventing a kind here would be a
    // guess a product then filters on.
    type: 'resource',
    title: entry.title ?? entry.name ?? entry.uri,
    content,
    mimeType: entry.mimeType ?? null,
    // Flat namespace: the protocol has no containment.
    parentId: null,
    url: openableUrl(entry.uri),
    metadata: {
      uri: entry.uri,
      ...pickDefined('name', entry.name),
      ...pickDefined('description', entry.description),
    },
    // MCP carries no timestamps. Null is the truth; `new Date()` would be a
    // fabrication a product would sort by.
    createdAt: null,
    updatedAt: null,
  };
}

function pickDefined<T>(key: string, value: T | undefined): Record<string, T> {
  return value === undefined ? {} : { [key]: value };
}
