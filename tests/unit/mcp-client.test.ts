// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Consuming somebody else's MCP server.
 *
 * Two things carry the weight here. That an MCP server becomes an ordinary
 * connector, with no capability claimed that the protocol cannot honour. And
 * that a session — which MCP makes stateful, opened under one tenant's
 * credential — is never handed to another tenant.
 *
 * The server is treated throughout as what it is: input written by somebody
 * else, which may be malformed, enormous, or both.
 */

import { describe, expect, it, vi } from 'vitest';

import { McpConnector } from '../../src/connections/connectors/mcp-connector.js';
import { ConnectorError, type ConnectorContext } from '../../src/connections/connector.js';
import { HttpMcpTransport } from '../../src/mcp/http-mcp-transport.js';
import { McpClient, type McpCallContext, type McpTransport } from '../../src/mcp/mcp-client.js';
import type { JsonRpcRequest, JsonRpcResponse } from '../../src/mcp/protocol.js';

interface Exchange {
  readonly method: string;
  readonly params: unknown;
  readonly credential: unknown;
  readonly sessionId?: string;
}

/** An MCP server the test scripts, recording what it was asked and as whom. */
function server(
  replies: Record<string, (params: Record<string, unknown>) => unknown>,
  options: { sessionId?: string } = {},
) {
  const exchanges: Exchange[] = [];
  const transport: McpTransport = {
    send: (request: JsonRpcRequest, context: McpCallContext) => {
      exchanges.push({
        method: request.method,
        params: request.params,
        credential: context.credential,
        ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
      });
      const reply = replies[request.method];
      const response: JsonRpcResponse = reply
        ? {
            jsonrpc: '2.0',
            id: request.id ?? null,
            result: reply((request.params ?? {}) as Record<string, unknown>),
          }
        : {
            jsonrpc: '2.0',
            id: request.id ?? null,
            error: { code: -32601, message: 'method not found' },
          };
      return Promise.resolve({
        response,
        ...(request.method === 'initialize' && options.sessionId !== undefined
          ? { sessionId: options.sessionId }
          : {}),
      });
    },
  };
  return { transport, exchanges };
}

const HANDSHAKE = {
  protocolVersion: '2025-06-18',
  capabilities: { resources: {} },
  serverInfo: { name: 'wiki', version: '1' },
};

function context(overrides: Partial<ConnectorContext> = {}): ConnectorContext {
  return {
    tenantId: 'tenant-1',
    connectionId: 'connection-1',
    credential: 'token-1',
    ...overrides,
  };
}

describe('an MCP server as a connector', () => {
  it('claims only what the protocol can honour', () => {
    const { transport } = server({});

    // MCP's resource primitive is list and read. Declaring search or a write
    // would fail at the first live call, which is what the registry check on
    // capabilities exists to prevent.
    expect(new McpConnector(transport).capabilities).toEqual(['list', 'read']);
  });

  it('shakes hands before anything else', async () => {
    const { transport, exchanges } = server({
      initialize: () => HANDSHAKE,
      'resources/list': () => ({ resources: [] }),
    });

    await new McpConnector(transport).list(context());

    expect(exchanges.map((exchange) => exchange.method)).toEqual(['initialize', 'resources/list']);
  });

  it('turns an MCP resource into the shape every connector speaks', async () => {
    const { transport } = server({
      initialize: () => HANDSHAKE,
      'resources/list': () => ({
        resources: [
          {
            uri: 'https://wiki.internal/page/1',
            name: 'onboarding',
            title: 'Onboarding',
            description: 'How to start',
            mimeType: 'text/markdown',
          },
        ],
        nextCursor: 'page-2',
      }),
    });

    const page = await new McpConnector(transport).list(context());

    expect(page.resources[0]).toMatchObject({
      id: 'https://wiki.internal/page/1',
      type: 'resource',
      title: 'Onboarding',
      content: null,
      mimeType: 'text/markdown',
      parentId: null,
      url: 'https://wiki.internal/page/1',
    });
    expect(page.nextCursor).toBe('page-2');
  });

  it('leaves timestamps null rather than inventing them', async () => {
    const { transport } = server({
      initialize: () => HANDSHAKE,
      'resources/list': () => ({ resources: [{ uri: 'file:///notes.md' }] }),
    });

    const page = await new McpConnector(transport).list(context());

    // MCP carries no timestamps. `new Date()` would be a fabrication a product
    // would then sort by.
    expect(page.resources[0]).toMatchObject({
      createdAt: null,
      updatedAt: null,
      // And a non-http uri is an id, not a link to hand a human.
      url: null,
      title: 'file:///notes.md',
    });
  });

  it('joins the text of a read and leaves base64 out of it', async () => {
    const { transport } = server({
      initialize: () => HANDSHAKE,
      'resources/read': () => ({
        contents: [
          { uri: 'doc:1', mimeType: 'text/plain', text: 'first' },
          { uri: 'doc:1', mimeType: 'image/png', blob: 'iVBORw0KGgo=' },
          { uri: 'doc:1', text: 'second' },
        ],
      }),
    });

    const resource = await new McpConnector(transport).read(context(), 'doc:1');

    // Base64 in a model's context is tokens spent on noise.
    expect(resource.content).toBe('first\n\nsecond');
  });

  it('fails rather than returning an empty resource', async () => {
    const { transport } = server({
      initialize: () => HANDSHAKE,
      'resources/read': () => ({ contents: [] }),
    });

    await expect(new McpConnector(transport).read(context(), 'doc:1')).rejects.toBeInstanceOf(
      ConnectorError,
    );
  });

  it('says at the handshake that a server has no resources', async () => {
    const { transport } = server({
      initialize: () => ({ ...HANDSHAKE, capabilities: { tools: {} } }),
    });

    // A bare "method not found" on the first list would send someone hunting
    // for a bug; the answer is to connect a different server.
    await expect(new McpConnector(transport).list(context())).rejects.toThrow(
      /exposes no resources/,
    );
  });

  it('carries a server error up as a failure, not as an empty page', async () => {
    const { transport } = server({ initialize: () => HANDSHAKE });

    await expect(new McpConnector(transport).list(context())).rejects.toThrow(
      /refused resources\/list/,
    );
  });
});

describe('MCP sessions belong to one tenant', () => {
  it('opens a separate session for each tenant on the same server', async () => {
    const { transport, exchanges } = server(
      { initialize: () => HANDSHAKE, 'resources/list': () => ({ resources: [] }) },
      { sessionId: 'session-abc' },
    );
    const connector = new McpConnector(transport);

    await connector.list(context({ tenantId: 'tenant-1', credential: 'token-1' }));
    await connector.list(context({ tenantId: 'tenant-2', credential: 'token-2' }));

    // Two handshakes, not one. A shared session would hand tenant 2 a handle
    // opened with tenant 1's credential — the cross-tenant leak the schema
    // spends a constraint preventing everywhere else.
    const handshakes = exchanges.filter((exchange) => exchange.method === 'initialize');
    expect(handshakes.map((exchange) => exchange.credential)).toEqual(['token-1', 'token-2']);
  });

  it('reuses the session for the same tenant and connection', async () => {
    const { transport, exchanges } = server(
      { initialize: () => HANDSHAKE, 'resources/list': () => ({ resources: [] }) },
      { sessionId: 'session-abc' },
    );
    const connector = new McpConnector(transport);

    await connector.list(context());
    await connector.list(context());

    expect(exchanges.filter((exchange) => exchange.method === 'initialize')).toHaveLength(1);
    // And the id the server handed back is echoed, which is what makes it a
    // session rather than two unrelated calls.
    expect(exchanges.at(-1)?.sessionId).toBe('session-abc');
  });

  it('does not share a session between two connections of one tenant', async () => {
    const { transport, exchanges } = server(
      { initialize: () => HANDSHAKE, 'resources/list': () => ({ resources: [] }) },
      { sessionId: 'session-abc' },
    );
    const connector = new McpConnector(transport);

    await connector.list(context({ connectionId: 'connection-1' }));
    await connector.list(context({ connectionId: 'connection-2' }));

    // Two connections are two credentials, whoever owns them.
    expect(exchanges.filter((exchange) => exchange.method === 'initialize')).toHaveLength(2);
  });

  it('never holds on to the credential', async () => {
    const { transport, exchanges } = server({
      initialize: () => HANDSHAKE,
      'resources/list': () => ({ resources: [] }),
    });
    const connector = new McpConnector(transport);

    await connector.list(context({ credential: 'first' }));
    await connector.list(context({ credential: 'second' }));

    // A refreshed token must reach the server on the very next call: the vault
    // stays the source of truth, and nothing here caches a secret.
    expect(exchanges.at(-1)?.credential).toBe('second');
  });

  it('evicts the oldest session rather than growing forever', async () => {
    const { transport, exchanges } = server({
      initialize: () => HANDSHAKE,
      'resources/list': () => ({ resources: [] }),
    });
    const connector = new McpConnector(transport, { maxSessions: 2 });

    await connector.list(context({ tenantId: 'a' }));
    await connector.list(context({ tenantId: 'b' }));
    await connector.list(context({ tenantId: 'c' })); // evicts 'a'
    await connector.list(context({ tenantId: 'a' })); // so 'a' shakes hands again

    // One session per tenant per connection would otherwise grow for the life
    // of the process; a re-handshake is one round trip.
    expect(exchanges.filter((exchange) => exchange.method === 'initialize')).toHaveLength(4);
  });

  it('passes the deadline down to the transport', async () => {
    const signals: (AbortSignal | undefined)[] = [];
    const transport: McpTransport = {
      send: (request, ctx) => {
        signals.push(ctx.signal);
        return Promise.resolve({
          response: {
            jsonrpc: '2.0',
            id: request.id ?? null,
            result: request.method === 'initialize' ? HANDSHAKE : { resources: [] },
          },
        });
      },
    };

    const controller = new AbortController();
    await new McpConnector(transport).list(context({ signal: controller.signal }));

    // A server that stops answering must not hold a turn open forever.
    expect(signals.every((signal) => signal === controller.signal)).toBe(true);
  });
});

describe('a third-party server is untrusted input', () => {
  it('drops a resource with no uri instead of repairing it', async () => {
    const { transport } = server({
      initialize: () => HANDSHAKE,
      'resources/list': () => ({
        resources: [{ name: 'no uri here' }, { uri: 'doc:1' }, 'not even an object'],
      }),
    });

    const page = await new McpConnector(transport).list(context());

    // A resource with no uri cannot be read back, so forwarding it would only
    // produce a failure later, further from the cause.
    expect(page.resources.map((resource) => resource.id)).toEqual(['doc:1']);
  });

  it('caps how much text one resource can contribute', async () => {
    const { transport } = server({
      initialize: () => HANDSHAKE,
      'resources/read': () => ({ contents: [{ uri: 'doc:1', text: 'x'.repeat(5_000) }] }),
    });
    const connector = new McpConnector(transport, {
      client: new McpClient(transport, { maxContentBytes: 100 }),
    });

    // A server answering with a hundred megabytes should be a truncated read,
    // not a process that dies holding it.
    expect((await connector.read(context(), 'doc:1')).content).toHaveLength(100);
  });

  it('caps how many resources one page can contain', async () => {
    const { transport } = server({
      initialize: () => HANDSHAKE,
      'resources/list': () => ({
        resources: Array.from({ length: 5_000 }, (_unused, index) => ({ uri: `doc:${index}` })),
      }),
    });
    const connector = new McpConnector(transport, {
      client: new McpClient(transport, { maxPageSize: 10 }),
    });

    expect((await connector.list(context())).resources).toHaveLength(10);
  });

  it('rejects an answer that is not a result at all', async () => {
    const transport: McpTransport = {
      send: (request) =>
        Promise.resolve({
          response: { jsonrpc: '2.0', id: request.id ?? null, result: 'surprise' },
        }),
    };

    await expect(new McpConnector(transport).list(context())).rejects.toThrow(/not a result/);
  });
});

describe('MCP over HTTP', () => {
  function reply(body: string, init: ResponseInit = {}): Response {
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/json' },
      ...init,
    });
  }

  it('sends the credential as a bearer token', async () => {
    const calls: RequestInit[] = [];
    const transport = new HttpMcpTransport({
      url: 'https://wiki.internal/mcp',
      fetch: ((_url: string, init: RequestInit) => {
        calls.push(init);
        return Promise.resolve(reply('{"jsonrpc":"2.0","id":1,"result":{}}'));
      }) as unknown as typeof fetch,
    });

    await transport.send(
      { jsonrpc: '2.0', id: 1, method: 'ping', params: {} },
      { credential: 'token-1' },
    );

    const headers = calls[0]?.headers as Record<string, string>;
    expect(headers['authorization']).toBe('Bearer token-1');
    // Both, because the specification lets the server answer with either.
    expect(headers['accept']).toContain('text/event-stream');
  });

  it('takes the access token out of an OAuth credential', async () => {
    const calls: RequestInit[] = [];
    const transport = new HttpMcpTransport({
      url: 'https://wiki.internal/mcp',
      fetch: ((_url: string, init: RequestInit) => {
        calls.push(init);
        return Promise.resolve(reply('{"jsonrpc":"2.0","id":1,"result":{}}'));
      }) as unknown as typeof fetch,
    });

    await transport.send(
      { jsonrpc: '2.0', id: 1, method: 'ping', params: {} },
      { credential: { accessToken: 'oauth-token' } },
    );

    expect((calls[0]?.headers as Record<string, string>)['authorization']).toBe(
      'Bearer oauth-token',
    );
  });

  it('sends no authorization at all rather than a malformed one', async () => {
    const calls: RequestInit[] = [];
    const transport = new HttpMcpTransport({
      url: 'https://wiki.internal/mcp',
      fetch: ((_url: string, init: RequestInit) => {
        calls.push(init);
        return Promise.resolve(reply('{"jsonrpc":"2.0","id":1,"result":{}}'));
      }) as unknown as typeof fetch,
    });

    await transport.send({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }, { credential: {} });

    // A malformed header is worse than none: the server's answer then describes
    // the wrong problem.
    expect((calls[0]?.headers as Record<string, string>)['authorization']).toBeUndefined();
  });

  it('picks up the session id and echoes it', async () => {
    const calls: RequestInit[] = [];
    const transport = new HttpMcpTransport({
      url: 'https://wiki.internal/mcp',
      fetch: ((_url: string, init: RequestInit) => {
        calls.push(init);
        return Promise.resolve(
          reply('{"jsonrpc":"2.0","id":1,"result":{}}', {
            headers: { 'content-type': 'application/json', 'mcp-session-id': 'session-xyz' },
          }),
        );
      }) as unknown as typeof fetch,
    });

    const first = await transport.send(
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} },
      { credential: 'token' },
    );
    expect(first.sessionId).toBe('session-xyz');

    await transport.send(
      { jsonrpc: '2.0', id: 2, method: 'resources/list', params: {} },
      { credential: 'token', sessionId: 'session-xyz' },
    );
    expect((calls[1]?.headers as Record<string, string>)['mcp-session-id']).toBe('session-xyz');
  });

  it('reads a reply the server chose to stream', async () => {
    const transport = new HttpMcpTransport({
      url: 'https://wiki.internal/mcp',
      fetch: () =>
        Promise.resolve(
          reply('event: message\ndata: {"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n\n', {
            headers: { 'content-type': 'text/event-stream' },
          }),
        ),
    });

    const { response } = await transport.send(
      { jsonrpc: '2.0', id: 1, method: 'ping', params: {} },
      { credential: 'token' },
    );

    expect(response).toMatchObject({ result: { ok: true } });
  });

  it('turns an HTTP failure into a JSON-RPC error', async () => {
    const transport = new HttpMcpTransport({
      url: 'https://wiki.internal/mcp',
      fetch: () => Promise.resolve(reply('<html>gateway timeout</html>', { status: 504 })),
    });

    const { response } = await transport.send(
      { jsonrpc: '2.0', id: 1, method: 'ping', params: {} },
      { credential: 'token' },
    );

    // One failure shape for the client above to read, whichever layer broke.
    expect(response).toMatchObject({ error: { message: 'MCP server answered HTTP 504' } });
  });

  it('does not choke on a reply that is not JSON', async () => {
    const transport = new HttpMcpTransport({
      url: 'https://wiki.internal/mcp',
      fetch: () => Promise.resolve(reply('not json at all')),
    });

    const { response } = await transport.send(
      { jsonrpc: '2.0', id: 1, method: 'ping', params: {} },
      { credential: 'token' },
    );

    expect(response).toMatchObject({ error: { code: -32700 } });
    expect(String((response as { error: { message: string } }).error.message)).toContain(
      'not JSON',
    );
  });

  it('refuses an answer larger than the cap before reading it', async () => {
    const cancel = vi.fn(() => Promise.resolve());
    const transport = new HttpMcpTransport({
      url: 'https://wiki.internal/mcp',
      maxResponseBytes: 1_000,
      fetch: () => {
        const response = reply('{}', {
          headers: { 'content-type': 'application/json', 'content-length': '999999999' },
        });
        Object.defineProperty(response, 'body', { value: { cancel } });
        return Promise.resolve(response);
      },
    });

    await expect(
      transport.send({ jsonrpc: '2.0', id: 1, method: 'ping', params: {} }, { credential: 't' }),
    ).rejects.toThrow(/over the 1000 cap/);
    // The point of a cap is not to hold the thing it refused.
    expect(cancel).toHaveBeenCalled();
  });
});
