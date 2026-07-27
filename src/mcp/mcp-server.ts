// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * An MCP server that exposes the harness's connectors as tools.
 *
 * The connector contract is one resource shape, so this is one small set of
 * generic tools — list, read, search, create, update, delete — each taking a
 * `connectionId`, over any connected source. An MCP client (Cline, Claude Code,
 * another agent) speaks to it and reaches Confluence, Drive, GitHub, … through
 * the same six calls, without knowing any source's API.
 *
 * It is mechanics, not a server process. `handle` turns one JSON-RPC request
 * into one response; a product carries the bytes over stdio or HTTP and, in
 * doing so, decides which tenant a session belongs to (passed in as context) —
 * the same boundary OAuth draws for its callback. Two safety rules hold the
 * line: every call is tenant-scoped, so a session cannot reach another tenant's
 * connections; and writes are off by default (`allow` is read-only), so
 * exposing a source over MCP does not silently hand out create/update/delete.
 * Wiring MCP writes through the human-approval queue is a later step; until
 * then, opting into writes is a deliberate act by the product.
 */

import { z } from 'zod';

import type { ConnectionOperations } from '../connections/cached-connections.js';
import type {
  ConnectorCapability,
  ListOptions,
  ResourceDraft,
  ResourcePatch,
  SearchOptions,
} from '../connections/connector.js';
import type { JsonRpcRequest, JsonRpcResponse, McpToolDefinition } from './protocol.js';
import { ErrorCode, MCP_PROTOCOL_VERSION, errorResponse, success, textResult } from './protocol.js';

/** What the product resolves for a session: which tenant it acts as. */
export interface McpContext {
  readonly tenantId: string;
}

export interface McpServerOptions {
  readonly name?: string;
  readonly version?: string;
  /**
   * Which connector operations to expose as tools. Defaults to read-only; a
   * product enables writes deliberately by listing create/update/delete.
   */
  readonly allow?: readonly ConnectorCapability[];
}

const READ_ONLY: readonly ConnectorCapability[] = ['list', 'read', 'search'];

interface McpTool<Args = unknown> {
  readonly name: string;
  readonly description: string;
  readonly capability: ConnectorCapability;
  readonly destructive: boolean;
  readonly input: z.ZodType<Args>;
  run(ops: ConnectionOperations, tenantId: string, args: Args): Promise<unknown>;
}

/** Erase a tool's argument type for storage while keeping each `run` typed. */
function tool<Args>(definition: McpTool<Args>): McpTool {
  return definition;
}

const connectionId = z.string().min(1);
const resourceId = z.string().min(1);

const TOOLS: readonly McpTool[] = [
  tool({
    name: 'list_resources',
    description:
      'List resources in a connection (optionally within a parent container or of a given type).',
    capability: 'list',
    destructive: false,
    input: z.object({
      connectionId,
      type: z.string().optional(),
      parentId: z.string().optional(),
      cursor: z.string().optional(),
      limit: z.number().int().positive().optional(),
    }),
    run: (ops, tenantId, a) => ops.list(tenantId, a.connectionId, listOptions(a)),
  }),
  tool({
    name: 'read_resource',
    description: 'Read a single resource, including its content, by id.',
    capability: 'read',
    destructive: false,
    input: z.object({ connectionId, id: resourceId }),
    run: (ops, tenantId, a) => ops.read(tenantId, a.connectionId, a.id),
  }),
  tool({
    name: 'search_resources',
    description: 'Search a connection for resources matching a text query.',
    capability: 'search',
    destructive: false,
    input: z.object({
      connectionId,
      query: z.string(),
      cursor: z.string().optional(),
      limit: z.number().int().positive().optional(),
    }),
    run: (ops, tenantId, a) => ops.search(tenantId, a.connectionId, a.query, searchOptions(a)),
  }),
  tool({
    name: 'create_resource',
    description: 'Create a resource in a connection.',
    capability: 'create',
    destructive: true,
    input: z.object({
      connectionId,
      title: z.string(),
      type: z.string().optional(),
      content: z.string().optional(),
      parentId: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    run: (ops, tenantId, a) => ops.create(tenantId, a.connectionId, draft(a)),
  }),
  tool({
    name: 'update_resource',
    description: 'Update a resource by id; only the fields given are changed.',
    capability: 'update',
    destructive: true,
    input: z.object({
      connectionId,
      id: resourceId,
      title: z.string().optional(),
      content: z.string().optional(),
      metadata: z.record(z.string(), z.unknown()).optional(),
    }),
    run: (ops, tenantId, a) => ops.update(tenantId, a.connectionId, a.id, patch(a)),
  }),
  tool({
    name: 'delete_resource',
    description: 'Delete a resource by id.',
    capability: 'delete',
    destructive: true,
    input: z.object({ connectionId, id: resourceId }),
    run: async (ops, tenantId, a) => {
      await ops.delete(tenantId, a.connectionId, a.id);
      return { deleted: a.id };
    },
  }),
];

const callParams = z.object({
  name: z.string(),
  arguments: z.record(z.string(), z.unknown()).optional(),
});

export class McpServer {
  readonly #ops: ConnectionOperations;
  readonly #name: string;
  readonly #version: string;
  readonly #allow: ReadonlySet<ConnectorCapability>;
  readonly #tools: Map<string, McpTool>;

  constructor(ops: ConnectionOperations, options: McpServerOptions = {}) {
    this.#ops = ops;
    this.#name = options.name ?? 'yas-harness';
    this.#version = options.version ?? '0.0.0';
    this.#allow = new Set(options.allow ?? READ_ONLY);
    this.#tools = new Map(
      TOOLS.filter((t) => this.#allow.has(t.capability)).map((t) => [t.name, t]),
    );
  }

  /**
   * Handle one JSON-RPC message. Returns the response, or null for a
   * notification (a message with no id), which JSON-RPC forbids replying to.
   */
  async handle(request: unknown, context: McpContext): Promise<JsonRpcResponse | null> {
    if (!isRequest(request)) {
      return errorResponse(null, ErrorCode.InvalidRequest, 'invalid JSON-RPC request');
    }
    if (request.id === undefined || request.id === null) {
      return null; // a notification (e.g. notifications/initialized): no reply
    }
    const id = request.id;

    switch (request.method) {
      case 'initialize':
        return success(id, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: this.#name, version: this.#version },
        });
      case 'ping':
        return success(id, {});
      case 'tools/list':
        return success(id, { tools: this.#toolDefinitions() });
      case 'tools/call':
        return this.#callTool(id, request.params, context);
      default:
        return errorResponse(id, ErrorCode.MethodNotFound, `unknown method: ${request.method}`);
    }
  }

  #toolDefinitions(): McpToolDefinition[] {
    return [...this.#tools.values()].map((t) => ({
      name: t.name,
      description: t.description,
      inputSchema: z.toJSONSchema(t.input),
      annotations: { readOnlyHint: !t.destructive, destructiveHint: t.destructive },
    }));
  }

  async #callTool(
    id: string | number,
    params: unknown,
    context: McpContext,
  ): Promise<JsonRpcResponse> {
    const parsed = callParams.safeParse(params);
    if (!parsed.success) {
      return errorResponse(id, ErrorCode.InvalidParams, 'tools/call requires a tool name');
    }
    const tool = this.#tools.get(parsed.data.name);
    if (!tool) {
      // Unknown, or a write not enabled by `allow`: a client mistake about what
      // exists, so a protocol error rather than a tool result.
      return errorResponse(
        id,
        ErrorCode.InvalidParams,
        `unknown or disabled tool: ${parsed.data.name}`,
      );
    }

    const args = tool.input.safeParse(parsed.data.arguments ?? {});
    if (!args.success) {
      // Bad arguments come back as a tool result, so an agent client sees the
      // message and can correct the call, as native tools do.
      return success(id, textResult(`invalid arguments: ${zodMessage(args.error)}`, true));
    }

    try {
      const result = await tool.run(this.#ops, context.tenantId, args.data);
      return success(id, textResult(JSON.stringify(result, null, 2)));
    } catch (error) {
      return success(id, textResult(`error: ${errorMessage(error)}`, true));
    }
  }
}

// --- argument mapping -------------------------------------------------------

// The mapping helpers take the Zod-inferred args, whose optional fields are
// `T | undefined`; they include a key only when it is defined, so the built
// options satisfy the connector types under `exactOptionalPropertyTypes`.

function listOptions(a: {
  type?: string | undefined;
  parentId?: string | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
}): ListOptions {
  return {
    ...(a.type !== undefined ? { type: a.type } : {}),
    ...(a.parentId !== undefined ? { parentId: a.parentId } : {}),
    ...(a.cursor !== undefined ? { cursor: a.cursor } : {}),
    ...(a.limit !== undefined ? { limit: a.limit } : {}),
  };
}

function searchOptions(a: {
  cursor?: string | undefined;
  limit?: number | undefined;
}): SearchOptions {
  return {
    ...(a.cursor !== undefined ? { cursor: a.cursor } : {}),
    ...(a.limit !== undefined ? { limit: a.limit } : {}),
  };
}

function draft(a: {
  title: string;
  type?: string | undefined;
  content?: string | undefined;
  parentId?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}): ResourceDraft {
  return {
    title: a.title,
    ...(a.type !== undefined ? { type: a.type } : {}),
    ...(a.content !== undefined ? { content: a.content } : {}),
    ...(a.parentId !== undefined ? { parentId: a.parentId } : {}),
    ...(a.metadata !== undefined ? { metadata: a.metadata } : {}),
  };
}

function patch(a: {
  title?: string | undefined;
  content?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}): ResourcePatch {
  return {
    ...(a.title !== undefined ? { title: a.title } : {}),
    ...(a.content !== undefined ? { content: a.content } : {}),
    ...(a.metadata !== undefined ? { metadata: a.metadata } : {}),
  };
}

// --- helpers ----------------------------------------------------------------

function isRequest(value: unknown): value is JsonRpcRequest {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { jsonrpc?: unknown }).jsonrpc === '2.0' &&
    typeof (value as { method?: unknown }).method === 'string'
  );
}

function zodMessage(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
