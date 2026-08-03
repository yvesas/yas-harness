// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The other direction: talking **to** somebody else's MCP server.
 *
 * `mcp-server.ts` exposes our connectors as MCP tools. This consumes an MCP
 * server as a source, so anything already speaking the protocol — an internal
 * wiki, a vendor's index, a team's own server — becomes reachable through the
 * connector shape without a connector being written for it.
 *
 * The same split as the server side: **mechanics only**. This file builds and
 * reads JSON-RPC; an `McpTransport` carries the bytes. That is what keeps the
 * decision of *how* to reach a server — HTTP, a socket, a process — with the
 * product that knows its own deployment.
 *
 * ## What a third-party server is
 *
 * Untrusted input, in full. A resource's title, description and body are
 * written by whoever runs that server, and they land in a model's context.
 * Connecting one is a trust decision of the same weight as installing a
 * dependency, and it is the product's to make — nothing here can make it safe,
 * so nothing here pretends to. What this file does do is refuse to let a
 * server's answer be *larger* or *stranger* than declared: sizes are capped,
 * shapes are validated, and anything unrecognised is dropped rather than
 * forwarded.
 *
 * ## Sessions belong to one tenant
 *
 * MCP is stateful: `initialize` establishes a session, and a Streamable HTTP
 * server hands back a session id to echo on every later call. A session is
 * therefore a *credential-scoped* thing — it was opened with one tenant's token
 * and may carry that tenant's authorisation on the far side. Reusing one across
 * tenants would be the cross-tenant leak this codebase spends a schema
 * constraint preventing elsewhere, so the cache is keyed by tenant and
 * connection together, never by server.
 */

import {
  JSONRPC_VERSION,
  MCP_PROTOCOL_VERSION,
  type JsonRpcRequest,
  type JsonRpcResponse,
} from './protocol.js';

/** What one MCP call needs beyond the request itself. */
export interface McpCallContext {
  /** The resolved secret for this connection. The transport authenticates with it. */
  readonly credential: unknown;
  /** Returned by `initialize`; echoed on every later call in the session. */
  readonly sessionId?: string;
  readonly signal?: AbortSignal;
}

/** What a transport answers with, so a session id can be picked up. */
export interface McpTransportResponse {
  readonly response: JsonRpcResponse;
  /** From the server's `Mcp-Session-Id`, on the `initialize` reply. */
  readonly sessionId?: string;
}

/**
 * Port: carrying one JSON-RPC message to a server and back.
 *
 * `HttpMcpTransport` is the shipped one. **stdio is deliberately absent**: it
 * means spawning a child process, and a multi-tenant server that spawns one per
 * tenant has turned a connection into an execution surface. A product that
 * wants it for a local tool writes it in a dozen lines and owns that decision.
 */
export interface McpTransport {
  send(request: JsonRpcRequest, context: McpCallContext): Promise<McpTransportResponse>;
  /** Fire-and-forget: notifications take no reply, by the protocol. */
  notify?(request: Omit<JsonRpcRequest, 'id'>, context: McpCallContext): Promise<void>;
}

/** A resource as MCP describes one. */
export interface McpResource {
  readonly uri: string;
  readonly name?: string;
  readonly title?: string;
  readonly description?: string;
  readonly mimeType?: string;
}

export interface McpResourcePage {
  readonly resources: readonly McpResource[];
  readonly nextCursor: string | null;
}

/** One part of a `resources/read` answer. Binary parts are not text. */
export interface McpResourceContents {
  readonly uri: string;
  readonly mimeType?: string;
  readonly text?: string;
  readonly blob?: string;
}

export interface McpSession {
  readonly sessionId?: string;
  readonly serverName: string;
  readonly protocolVersion: string;
  /** What the server said it can do — checked before a call is attempted. */
  readonly supportsResources: boolean;
}

export class McpClientError extends Error {
  constructor(
    message: string,
    readonly detail: { readonly method: string; readonly code?: number },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'McpClientError';
  }
}

export interface McpClientOptions {
  /** How this client names itself in the handshake. */
  readonly clientName?: string;
  readonly clientVersion?: string;
  /**
   * Longest text this client will accept from one resource. Default 1 MiB.
   *
   * A server answering with a hundred megabytes should be a failed call, not a
   * process that dies holding it. The cap is here rather than in the transport
   * because it is a protocol decision, and every transport wants it.
   */
  readonly maxContentBytes?: number;
  /** Most resources accepted from one page. Default 1000. */
  readonly maxPageSize?: number;
}

const DEFAULTS = {
  clientName: 'yas-harness',
  clientVersion: '1',
  maxContentBytes: 1024 * 1024,
  maxPageSize: 1000,
} as const;

/**
 * One MCP server, spoken to correctly.
 *
 * Stateless on purpose: a session is passed in rather than held, so the same
 * client instance serves every tenant and the caller decides what a session
 * belongs to. `McpConnector` is the caller that gets that decision right.
 */
export class McpClient {
  readonly #transport: McpTransport;
  readonly #options: McpClientOptions;
  #nextId = 1;

  constructor(transport: McpTransport, options: McpClientOptions = {}) {
    this.#transport = transport;
    this.#options = options;
  }

  /** The handshake. Everything else is invalid before it. */
  async initialize(context: McpCallContext): Promise<McpSession> {
    const { response, sessionId } = await this.#transport.send(
      this.#request('initialize', {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: {
          name: this.#options.clientName ?? DEFAULTS.clientName,
          version: this.#options.clientVersion ?? DEFAULTS.clientVersion,
        },
      }),
      context,
    );

    const result = expectObject(unwrap(response, 'initialize'), 'initialize');
    const capabilities = asObject(result['capabilities']) ?? {};
    const serverInfo = asObject(result['serverInfo']) ?? {};
    const session: McpSession = {
      ...(sessionId === undefined ? {} : { sessionId }),
      serverName: asString(serverInfo['name']) ?? 'unknown',
      protocolVersion: asString(result['protocolVersion']) ?? MCP_PROTOCOL_VERSION,
      // Checked rather than assumed: a server with no resources should fail
      // saying so, not with a bare "method not found" three calls later.
      supportsResources: capabilities['resources'] !== undefined,
    };

    // The protocol requires it, and a server may withhold answers until it
    // arrives. Its absence must not fail the handshake, though — a transport
    // that cannot fire-and-forget is a transport, not a broken server.
    await this.#transport.notify?.(
      { jsonrpc: JSONRPC_VERSION, method: 'notifications/initialized' },
      { ...context, ...(session.sessionId === undefined ? {} : { sessionId: session.sessionId }) },
    );

    return session;
  }

  async listResources(
    context: McpCallContext,
    options: { readonly cursor?: string } = {},
  ): Promise<McpResourcePage> {
    const { response } = await this.#transport.send(
      this.#request(
        'resources/list',
        options.cursor === undefined ? {} : { cursor: options.cursor },
      ),
      context,
    );
    const result = expectObject(unwrap(response, 'resources/list'), 'resources/list');

    const raw = Array.isArray(result['resources']) ? result['resources'] : [];
    const max = this.#options.maxPageSize ?? DEFAULTS.maxPageSize;
    const resources = raw
      .slice(0, max)
      .map((entry) => toResource(entry))
      .filter((entry): entry is McpResource => entry !== null);

    return { resources, nextCursor: asString(result['nextCursor']) ?? null };
  }

  async readResource(context: McpCallContext, uri: string): Promise<McpResourceContents[]> {
    const { response } = await this.#transport.send(
      this.#request('resources/read', { uri }),
      context,
    );
    const result = expectObject(unwrap(response, 'resources/read'), 'resources/read');

    const raw = Array.isArray(result['contents']) ? result['contents'] : [];
    const limit = this.#options.maxContentBytes ?? DEFAULTS.maxContentBytes;
    return raw
      .map((entry) => toContents(entry, limit))
      .filter((entry): entry is McpResourceContents => entry !== null);
  }

  #request(method: string, params: Record<string, unknown>): JsonRpcRequest {
    return { jsonrpc: JSONRPC_VERSION, id: this.#nextId++, method, params };
  }
}

/** A JSON-RPC error is a failed call, not a result to hand upward. */
function unwrap(response: JsonRpcResponse, method: string): unknown {
  if ('error' in response) {
    throw new McpClientError(`MCP server refused ${method}: ${response.error.message}`, {
      method,
      code: response.error.code,
    });
  }
  return response.result;
}

function expectObject(value: unknown, method: string): Record<string, unknown> {
  const object = asObject(value);
  if (!object) {
    throw new McpClientError(`MCP server answered ${method} with something that is not a result`, {
      method,
    });
  }
  return object;
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** A resource with no `uri` cannot be read back, so it is dropped, not repaired. */
function toResource(entry: unknown): McpResource | null {
  const object = asObject(entry);
  const uri = asString(object?.['uri']);
  if (!object || uri === undefined) {
    return null;
  }
  return {
    uri,
    ...pick(object, 'name'),
    ...pick(object, 'title'),
    ...pick(object, 'description'),
    ...pick(object, 'mimeType'),
  };
}

function toContents(entry: unknown, maxBytes: number): McpResourceContents | null {
  const object = asObject(entry);
  const uri = asString(object?.['uri']);
  if (!object || uri === undefined) {
    return null;
  }

  const text = asString(object['text']);
  return {
    uri,
    ...pick(object, 'mimeType'),
    // Truncated rather than refused: a body over the cap is usually a server
    // being generous, and half a document beats a failed turn.
    ...(text === undefined ? {} : { text: text.slice(0, maxBytes) }),
    ...pick(object, 'blob'),
  };
}

function pick(object: Record<string, unknown>, key: string): Record<string, string> {
  const value = asString(object[key]);
  return value === undefined ? {} : { [key]: value };
}
