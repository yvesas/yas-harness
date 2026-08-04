// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The MCP server, driven by a fake of the connection operations. What is proven
 * is the protocol surface: the initialize handshake, tools/list reflecting the
 * read-only-by-default policy (and writes when allowed), tools/call routing to
 * the tenant-scoped operations, arguments and connector failures coming back as
 * tool-result errors, unknown methods/tools as JSON-RPC errors, and no reply to
 * a notification.
 */

import { describe, expect, it } from 'vitest';

import type { ConnectionOperations } from '../../src/connections/cached-connections.js';
import type {
  ListOptions,
  Resource,
  ResourceDraft,
  ResourcePatch,
  ResourcePage,
  SearchOptions,
} from '../../src/connections/connector.js';
import { McpServer } from '../../src/mcp/mcp-server.js';
import type { McpServerOptions } from '../../src/mcp/mcp-server.js';
import type {
  JsonRpcErrorResponse,
  JsonRpcSuccess,
  McpToolResult,
} from '../../src/mcp/protocol.js';

function resource(id: string): Resource {
  return {
    id,
    type: 'doc',
    title: `title ${id}`,
    content: 'body',
    mimeType: 'text/plain',
    parentId: null,
    url: null,
    metadata: {},
    createdAt: null,
    updatedAt: null,
  };
}

type Call = [string, ...unknown[]];

// The fake's methods are async but do no awaiting; that is the point of a
// double, so silence the rule here as the real in-memory adapters do.
/* eslint-disable @typescript-eslint/require-await */
class FakeOps implements ConnectionOperations {
  readonly calls: Call[] = [];
  error: Error | null = null;

  async read(tenantId: string, connectionId: string, id: string): Promise<Resource> {
    this.calls.push(['read', tenantId, connectionId, id]);
    if (this.error) throw this.error;
    return resource(id);
  }
  async list(tenantId: string, connectionId: string, options?: ListOptions): Promise<ResourcePage> {
    this.calls.push(['list', tenantId, connectionId, options]);
    return { resources: [resource('a')], nextCursor: null };
  }
  async search(
    tenantId: string,
    connectionId: string,
    query: string,
    options?: SearchOptions,
  ): Promise<ResourcePage> {
    this.calls.push(['search', tenantId, connectionId, query, options]);
    return { resources: [], nextCursor: null };
  }
  async create(tenantId: string, connectionId: string, draft: ResourceDraft): Promise<Resource> {
    this.calls.push(['create', tenantId, connectionId, draft]);
    return resource('new');
  }
  async update(
    tenantId: string,
    connectionId: string,
    id: string,
    patch: ResourcePatch,
  ): Promise<Resource> {
    this.calls.push(['update', tenantId, connectionId, id, patch]);
    return resource(id);
  }
  async delete(tenantId: string, connectionId: string, id: string): Promise<void> {
    this.calls.push(['delete', tenantId, connectionId, id]);
  }
}
/* eslint-enable @typescript-eslint/require-await */

const ctx = { tenantId: 'T1' };

function req(id: number | string | null, method: string, params?: unknown) {
  return { jsonrpc: '2.0' as const, id, method, ...(params === undefined ? {} : { params }) };
}

function build(options?: McpServerOptions): { server: McpServer; ops: FakeOps } {
  const ops = new FakeOps();
  return { server: new McpServer(ops, options), ops };
}

function asSuccess(value: unknown): JsonRpcSuccess {
  return value as JsonRpcSuccess;
}
function asError(value: unknown): JsonRpcErrorResponse {
  return value as JsonRpcErrorResponse;
}
function toolResult(value: unknown): McpToolResult {
  return asSuccess(value).result as McpToolResult;
}

describe('McpServer — protocol', () => {
  it('answers initialize with server info and tool capabilities', async () => {
    const { server } = build();

    const res = asSuccess(await server.handle(req(1, 'initialize'), ctx));

    expect(res.result).toMatchObject({
      capabilities: { tools: {} },
      serverInfo: { name: 'yas-harness' },
    });
    expect((res.result as { protocolVersion: string }).protocolVersion).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it('does not reply to a notification (no id)', async () => {
    const { server } = build();

    const res = await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }, ctx);

    expect(res).toBeNull();
  });

  it('rejects a non-JSON-RPC message', async () => {
    const { server } = build();

    const res = asError(await server.handle({ hello: 'world' }, ctx));
    expect(res.error.code).toBe(-32600);
  });

  it('returns method-not-found for an unknown method', async () => {
    const { server } = build();

    const res = asError(await server.handle(req(1, 'resources/list'), ctx));
    expect(res.error.code).toBe(-32601);
  });
});

describe('McpServer — tools/list policy', () => {
  it('lists only read tools by default, marked read-only', async () => {
    const { server } = build();

    const res = asSuccess(await server.handle(req(1, 'tools/list'), ctx));
    const tools = (
      res.result as { tools: { name: string; annotations?: { readOnlyHint?: boolean } }[] }
    ).tools;

    expect(tools.map((t) => t.name)).toEqual([
      'list_resources',
      'read_resource',
      'search_resources',
    ]);
    expect(tools.every((t) => t.annotations?.readOnlyHint === true)).toBe(true);
  });

  it('lists write tools when they are allowed', async () => {
    // `ungated` because this is about `allow` shaping the tool list, not about
    // the gate. Enabling a write without deciding who asks now throws — see
    // mcp-approval.test.ts.
    const { server } = build({
      allow: ['list', 'read', 'search', 'create', 'update', 'delete'],
      ungated: true,
    });

    const res = asSuccess(await server.handle(req(1, 'tools/list'), ctx));
    const names = (res.result as { tools: { name: string }[] }).tools.map((t) => t.name);

    expect(names).toContain('create_resource');
    expect(names).toContain('delete_resource');
  });
});

describe('McpServer — tools/call', () => {
  it('routes read_resource to the tenant-scoped operation', async () => {
    const { server, ops } = build();

    const res = toolResult(
      await server.handle(
        req(1, 'tools/call', {
          name: 'read_resource',
          arguments: { connectionId: 'c1', id: 'x9' },
        }),
        ctx,
      ),
    );

    expect(ops.calls[0]).toEqual(['read', 'T1', 'c1', 'x9']);
    expect(res.isError).toBeUndefined();
    const parsed = JSON.parse(res.content[0]!.text) as Resource;
    expect(parsed.id).toBe('x9');
  });

  it('passes list options through', async () => {
    const { server, ops } = build();

    await server.handle(
      req(1, 'tools/call', {
        name: 'list_resources',
        arguments: { connectionId: 'c1', type: 'file', parentId: 'p1', limit: 5 },
      }),
      ctx,
    );

    expect(ops.calls[0]).toEqual(['list', 'T1', 'c1', { type: 'file', parentId: 'p1', limit: 5 }]);
  });

  it('refuses a write tool when it is not allowed', async () => {
    const { server, ops } = build(); // read-only

    const res = asError(
      await server.handle(
        req(1, 'tools/call', {
          name: 'delete_resource',
          arguments: { connectionId: 'c1', id: 'x' },
        }),
        ctx,
      ),
    );

    expect(res.error.code).toBe(-32602);
    expect(ops.calls).toHaveLength(0); // never reached the operation
  });

  it('runs a write tool when allowed', async () => {
    const { server, ops } = build({ allow: ['create'], ungated: true });

    await server.handle(
      req(1, 'tools/call', {
        name: 'create_resource',
        arguments: { connectionId: 'c1', title: 'New', content: 'hi' },
      }),
      ctx,
    );

    expect(ops.calls[0]).toEqual(['create', 'T1', 'c1', { title: 'New', content: 'hi' }]);
  });

  it('reports an unknown tool as a JSON-RPC error', async () => {
    const { server } = build();

    const res = asError(
      await server.handle(req(1, 'tools/call', { name: 'nope', arguments: {} }), ctx),
    );
    expect(res.error.code).toBe(-32602);
  });

  it('returns invalid arguments as a tool-result error', async () => {
    const { server, ops } = build();

    const res = toolResult(
      await server.handle(
        req(1, 'tools/call', { name: 'read_resource', arguments: { id: 'x' } }), // no connectionId
        ctx,
      ),
    );

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/invalid arguments/);
    expect(ops.calls).toHaveLength(0);
  });

  it('returns a connector failure as a tool-result error', async () => {
    const { server, ops } = build();
    ops.error = new Error('source is down');

    const res = toolResult(
      await server.handle(
        req(1, 'tools/call', { name: 'read_resource', arguments: { connectionId: 'c1', id: 'x' } }),
        ctx,
      ),
    );

    expect(res.isError).toBe(true);
    expect(res.content[0]!.text).toMatch(/source is down/);
  });
});
