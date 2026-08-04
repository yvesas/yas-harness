// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A write over MCP now has to get past a person.
 *
 * The agent loop's gate pauses a turn. MCP has no turn, so the only honest gate
 * is to refuse and record: the call does not run, an approval is created, the
 * client is told the id, and it calls again once somebody has decided.
 *
 * The case that carries the most weight is the last one in the first block: an
 * approval is for *these arguments*, not for this tool. Without that, a client
 * gets a person to approve something harmless and then sends something else.
 */

import { describe, expect, it } from 'vitest';

import { InMemoryApprovalStore } from '../../src/approval/in-memory-approval-store.js';
import type { ConnectionOperations } from '../../src/connections/cached-connections.js';
import type { Resource } from '../../src/connections/connector.js';
import { requestId } from '../../src/mcp/mcp-approval.js';
import { McpServer, McpUngatedWriteError } from '../../src/mcp/mcp-server.js';

const TENANT = 'tenant-1';
const SESSION = 'session-mcp';
const CONNECTION = 'connection-1';

function resource(title: string): Resource {
  return {
    id: 'doc-1',
    type: 'file',
    title,
    content: null,
    mimeType: null,
    parentId: null,
    url: null,
    metadata: {},
    createdAt: null,
    updatedAt: null,
  };
}

/** The connector side, recording whether a write actually happened. */
function operations() {
  const created: string[] = [];
  const ops = {
    create: (_tenantId: string, _connectionId: string, draft: { title: string }) => {
      created.push(draft.title);
      return Promise.resolve(resource(draft.title));
    },
    list: () => Promise.resolve({ resources: [], nextCursor: null }),
  } as unknown as ConnectionOperations;
  return { ops, created };
}

function callCreate(title: string, extra: Record<string, unknown> = {}) {
  return {
    jsonrpc: '2.0' as const,
    id: 1,
    method: 'tools/call',
    params: {
      name: 'create_resource',
      arguments: { connectionId: CONNECTION, title, ...extra },
    },
  };
}

function text(response: unknown): string {
  const result = (response as { result: { content: { text: string }[]; isError?: boolean } })
    .result;
  return result.content[0]?.text ?? '';
}

function isError(response: unknown): boolean {
  return (response as { result: { isError?: boolean } }).result.isError === true;
}

/**
 * The anchor session is **per tenant**, as the port documents — approvals are
 * unique on `(session_id, tool_call_id)`, so one shared session would make two
 * tenants collide on identical arguments.
 */
function sessionFor(tenantId: string): Promise<string> {
  return Promise.resolve(tenantId === TENANT ? SESSION : `session-mcp-${tenantId}`);
}

function build(store = new InMemoryApprovalStore()) {
  const { ops, created } = operations();
  const server = new McpServer(ops, {
    allow: ['list', 'read', 'search', 'create'],
    approvals: { store, session: sessionFor },
  });
  return { server, store, created };
}

describe('a write over MCP is refused and recorded', () => {
  it('does not run, and says what to do about it', async () => {
    const { server, store, created } = build();

    const response = await server.handle(callCreate('report.md'), { tenantId: TENANT });
    const [pending] = await store.list(TENANT, SESSION);

    // The whole mechanism: nothing happened, and the client was told why.
    expect(created).toEqual([]);
    expect(isError(response)).toBe(true);
    // The **approval's** id, not the request hash: that is what a person acts
    // on in the queue, and the client is what relays it to them.
    expect(text(response)).toContain(`awaiting approval: ${pending!.id}`);
    expect(text(response)).toMatch(/make the same call again/);
  });

  it('records the call as a pending approval a person can read', async () => {
    const { server, store } = build();

    await server.handle(callCreate('report.md'), { tenantId: TENANT });
    const [pending] = await store.list(TENANT, SESSION);

    expect(pending).toMatchObject({
      status: 'pending',
      toolName: 'create_resource',
      input: { connectionId: CONNECTION, title: 'report.md' },
    });
  });

  it('runs once a person has approved, on the second call', async () => {
    const { server, store, created } = build();

    await server.handle(callCreate('report.md'), { tenantId: TENANT });
    const [pending] = await store.list(TENANT, SESSION);
    await store.approve(TENANT, pending!.id, { decidedBy: 'yves' });

    const response = await server.handle(callCreate('report.md'), { tenantId: TENANT });

    expect(created).toEqual(['report.md']);
    expect(isError(response)).toBe(false);
  });

  it('approves those arguments, not that tool', async () => {
    const { server, store, created } = build();

    await server.handle(callCreate('report.md'), { tenantId: TENANT });
    const [pending] = await store.list(TENANT, SESSION);
    await store.approve(TENANT, pending!.id, { decidedBy: 'yves' });

    // Same tool, different input. Without this, a client gets approval for
    // something harmless and then sends something else.
    const response = await server.handle(callCreate('payroll.csv'), { tenantId: TENANT });

    expect(created).toEqual([]);
    expect(text(response)).toMatch(/awaiting approval/);
  });

  it('does not ask twice while a decision is outstanding', async () => {
    const { server, store } = build();

    await server.handle(callCreate('report.md'), { tenantId: TENANT });
    await server.handle(callCreate('report.md'), { tenantId: TENANT });
    await server.handle(callCreate('report.md'), { tenantId: TENANT });

    // A client polling every few seconds must not fill an operator's inbox
    // with the same question.
    expect(await store.list(TENANT, SESSION)).toHaveLength(1);
  });

  it('tells the client why it was rejected, so it stops asking', async () => {
    const { server, store, created } = build();

    await server.handle(callCreate('report.md'), { tenantId: TENANT });
    const [pending] = await store.list(TENANT, SESSION);
    await store.reject(TENANT, pending!.id, { decidedBy: 'yves', reason: 'not that folder' });

    const response = await server.handle(callCreate('report.md'), { tenantId: TENANT });

    expect(created).toEqual([]);
    // "No" with no reason gets retried forever, and a person is asked the same
    // question every time.
    expect(text(response)).toMatch(/rejected by yves: not that folder/);
  });

  it('leaves reads alone', async () => {
    const { server, store } = build();

    const response = await server.handle(
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'list_resources', arguments: { connectionId: CONNECTION } },
      },
      { tenantId: TENANT },
    );

    // Asking a person to approve a `list` teaches everyone to click through
    // without reading, which costs more than it buys.
    expect(isError(response)).toBe(false);
    expect(await store.list(TENANT, SESSION)).toHaveLength(0);
  });

  it('keeps one tenant’s approval from unlocking another’s call', async () => {
    const { server, store, created } = build();

    await server.handle(callCreate('report.md'), { tenantId: TENANT });
    const [pending] = await store.list(TENANT, SESSION);
    await store.approve(TENANT, pending!.id, { decidedBy: 'yves' });

    const response = await server.handle(callCreate('report.md'), { tenantId: 'tenant-2' });

    // Identical arguments hash the same, so the lookup has to be scoped by
    // tenant or one customer's yes would answer for everybody.
    expect(created).toEqual([]);
    expect(text(response)).toMatch(/awaiting approval/);
  });
});

describe('the request id', () => {
  it('is stable across calls, since nothing else survives a retry', () => {
    expect(requestId('create_resource', { title: 'a' })).toBe(
      requestId('create_resource', { title: 'a' }),
    );
  });

  it('ignores the order the arguments arrived in', () => {
    // JSON.stringify preserves insertion order, so a client that reorders its
    // arguments between two calls would ask a person the same question twice.
    expect(requestId('create_resource', { a: 1, b: 2 })).toBe(
      requestId('create_resource', { b: 2, a: 1 }),
    );
  });

  it('does not ignore the order of an array', () => {
    // There, order is meaning.
    expect(requestId('create_resource', { ids: [1, 2] })).not.toBe(
      requestId('create_resource', { ids: [2, 1] }),
    );
  });

  it('changes with the tool', () => {
    expect(requestId('create_resource', { id: 'x' })).not.toBe(
      requestId('delete_resource', { id: 'x' }),
    );
  });
});

describe('exposing a write is a decision', () => {
  it('refuses to expose one with nobody asked', () => {
    const { ops } = operations();

    // At construction, not at the first write: a wiring mistake that surfaces
    // the day somebody deletes something is not a check.
    expect(() => new McpServer(ops, { allow: ['create', 'delete'] })).toThrow(McpUngatedWriteError);
  });

  it('allows it when somebody says so out loud', () => {
    const { ops } = operations();

    // A legitimate choice — a socket only an operator can open — but it should
    // be a sentence somebody wrote.
    expect(() => new McpServer(ops, { allow: ['create'], ungated: true })).not.toThrow();
  });

  it('refuses a write the gate was configured not to cover', () => {
    const { ops } = operations();

    // `gate: ['create']` with `allow: ['create','delete']` leaves delete open.
    // Naming one write must not be read as covering the rest.
    expect(
      () =>
        new McpServer(ops, {
          allow: ['create', 'delete'],
          approvals: {
            store: new InMemoryApprovalStore(),
            session: () => Promise.resolve(SESSION),
            gate: ['create'],
          },
        }),
    ).toThrow(/delete/);
  });

  it('stays read-only by default, and needs no gate for that', () => {
    const { ops } = operations();

    expect(() => new McpServer(ops)).not.toThrow();
  });
});
