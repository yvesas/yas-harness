// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Every in-memory adapter isolates tenants as strictly as its table does.
 *
 * The Postgres adapters each have isolation tests, and the schema is checked by
 * `npm run isolation`. The in-memory ones are the gap that matters more than it
 * looks: they exist so a product can test its own agents without a database
 * (`docs/architecture.md`), which means a product's whole test suite can pass
 * against an adapter that leaks. A false pass here is worse than no test — it
 * is a product shipping on a guarantee it never actually checked.
 *
 * So the shape of every case is the same, and deliberately blunt: tenant A
 * writes; tenant B must not see it, must not change it, and must not delete it.
 */

import { describe, expect, it } from 'vitest';

import { InMemoryApprovalStore } from '../../src/approval/in-memory-approval-store.js';
import { InMemoryConnectionStore } from '../../src/connections/in-memory-connection-store.js';
import { InMemoryResourceCacheStore } from '../../src/connections/in-memory-resource-cache-store.js';
import { InMemorySessionStore } from '../../src/memory/in-memory-session-store.js';
import { InMemoryPoolStore } from '../../src/pools/in-memory-pool-store.js';
import { InMemoryTenantStore } from '../../src/tenants/in-memory-tenant-store.js';
import { InMemoryTraceRecorder } from '../../src/telemetry/trace.js';
import { InMemoryUsageRecorder } from '../../src/telemetry/model-usage.js';
import { userMessage } from '../../src/models/model-gateway.js';
import type { Resource } from '../../src/connections/connector.js';

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('tenant isolation, in memory', () => {
  it('sessions: B cannot find, read or append to A’s conversation', async () => {
    const sessions = new InMemorySessionStore();
    const session = await sessions.create({ tenantId: A, personaId: 'default' });
    await sessions.append(A, session.id, [userMessage('mine')]);

    expect(await sessions.find(B, session.id)).toBeNull();
    expect(await sessions.messages(B, session.id)).toEqual([]);
    // Appending across the boundary must fail outright, not append quietly.
    await expect(sessions.append(B, session.id, [userMessage('theirs')])).rejects.toThrow();
    // And A's conversation is untouched by the attempt.
    expect(await sessions.messages(A, session.id)).toHaveLength(1);
  });

  it('pools: the same module id in another tenant is a different pool', async () => {
    const pools = new InMemoryPoolStore();
    await pools.set({ tenantId: A, moduleId: 'ledger' }, 'balance', 41);

    expect(await pools.get({ tenantId: B, moduleId: 'ledger' }, 'balance')).toBeNull();
    expect(await pools.list({ tenantId: B, moduleId: 'ledger' })).toEqual([]);
    expect(await pools.delete({ tenantId: B, moduleId: 'ledger' }, 'balance')).toBe(false);
    // B writing the same key must not overwrite A's value.
    await pools.set({ tenantId: B, moduleId: 'ledger' }, 'balance', 0);
    expect(await pools.get({ tenantId: A, moduleId: 'ledger' }, 'balance')).toMatchObject({
      value: 41,
    });
  });

  it('pools: a tenant id that runs into the module id cannot collide', async () => {
    const pools = new InMemoryPoolStore();

    // Without length-prefixed keys, "ab" + "c" and "a" + "bc" would be the
    // same string. This is the collision the key format exists to prevent.
    await pools.set({ tenantId: 'ab', moduleId: 'c' }, 'k', 'first');
    await pools.set({ tenantId: 'a', moduleId: 'bc' }, 'k', 'second');

    expect(await pools.get({ tenantId: 'ab', moduleId: 'c' }, 'k')).toMatchObject({
      value: 'first',
    });
  });

  it('approvals: B cannot see, find or decide A’s pending action', async () => {
    const approvals = new InMemoryApprovalStore();
    const [pending] = await approvals.request([
      { tenantId: A, sessionId: 's1', toolCallId: 'c1', toolName: 'send', input: {} },
    ]);

    expect(await approvals.find(B, pending!.id)).toBeNull();
    expect(await approvals.list(B, 's1')).toEqual([]);
    expect(await approvals.forToolCalls(B, 's1', ['c1'])).toEqual([]);
    // Deciding another tenant's approval is the dangerous one: it would run a
    // gated action on their behalf.
    await expect(approvals.approve(B, pending!.id, { decidedBy: 'intruder' })).rejects.toThrow();
    expect(await approvals.find(A, pending!.id)).toMatchObject({ status: 'pending' });
  });

  it('connections: B cannot find, list, re-status or remove A’s connection', async () => {
    const connections = new InMemoryConnectionStore();
    const connection = await connections.create({ tenantId: A, connectorId: 'jira' });

    expect(await connections.find(B, connection.id)).toBeNull();
    expect(await connections.list(B)).toEqual([]);
    expect(await connections.remove(B, connection.id)).toBe(false);
    await expect(connections.setStatus(B, connection.id, 'revoked')).rejects.toThrow();
    expect(await connections.find(A, connection.id)).toMatchObject({ status: 'active' });
  });

  it('resource cache: a connection id reused across tenants keeps separate snapshots', async () => {
    const cache = new InMemoryResourceCacheStore();
    const scope = { connectionId: 'shared-id' };
    await cache.put({ tenantId: A, ...scope }, resource('doc-1', 'A’s title'));
    await cache.put({ tenantId: B, ...scope }, resource('doc-1', 'B’s title'));

    expect(await cache.get({ tenantId: A, ...scope }, 'doc-1')).toMatchObject({
      resource: { title: 'A’s title' },
    });
    expect(await cache.get({ tenantId: B, ...scope }, 'doc-1')).toMatchObject({
      resource: { title: 'B’s title' },
    });
    // And clearing one tenant's cache leaves the other's alone.
    await cache.delete({ tenantId: B, ...scope }, 'doc-1');
    expect(await cache.get({ tenantId: A, ...scope }, 'doc-1')).not.toBeNull();
  });

  it('traces: B cannot read A’s turn, even knowing its id', async () => {
    const traces = new InMemoryTraceRecorder();
    const step = {
      tenantId: A,
      sessionId: 's1',
      traceId: 'trace-1',
      sequence: 0,
      kind: 'input' as const,
      succeeded: true,
    };
    await traces.record(step);

    expect(await traces.trace(B, 'trace-1')).toEqual([]);
    expect(await traces.recent(B)).toEqual([]);
    expect(await traces.trace(A, 'trace-1')).toHaveLength(1);
  });

  it('usage: spend is reported per tenant, never pooled', async () => {
    const usage = new InMemoryUsageRecorder();
    await usage.record(record(A, 3));
    await usage.record(record(B, 5));

    expect((await usage.spend(A)).totalCostUsd).toBe(3);
    expect((await usage.spend(B)).totalCostUsd).toBe(5);
  });

  it('tenants: a slug taken by one tenant is not free for another', async () => {
    const tenants = new InMemoryTenantStore();
    const first = await tenants.create({ slug: 'acme', name: 'Acme' });

    await expect(tenants.create({ slug: 'acme', name: 'Impostor' })).rejects.toThrow();
    // And erasing one leaves the rest of the registry intact.
    const second = await tenants.create({ slug: 'other', name: 'Other' });
    expect(await tenants.delete(first.id)).toBe(true);
    expect(await tenants.find(second.id)).not.toBeNull();
  });
});

function resource(id: string, title: string): Resource {
  return {
    id,
    type: 'doc',
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

function record(tenantId: string, costUsd: number) {
  return {
    tenantId,
    sessionId: null,
    task: 'simple' as const,
    modelReference: 'cheap',
    provider: 'groq',
    model: 'llama',
    tier: 'cheap' as const,
    usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
    costUsd,
    latencyMs: 1,
    attempts: 1,
    succeeded: true,
  };
}
