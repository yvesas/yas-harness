// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The inbox: what is waiting on a person.
 *
 * Asked for by the console's Approvals page. `list` answers about one
 * conversation, which is only useful to somebody who already knows which
 * conversation to look at — and a person deciding does not.
 */

import { describe, expect, it } from 'vitest';

import { InMemoryApprovalStore } from '../../src/approval/in-memory-approval-store.js';

const TENANT = 'tenant-1';

async function queue(): Promise<InMemoryApprovalStore> {
  const store = new InMemoryApprovalStore();
  await store.request([
    { tenantId: TENANT, sessionId: 's1', toolCallId: 'c1', toolName: 'send_email', input: {} },
    { tenantId: TENANT, sessionId: 's2', toolCallId: 'c2', toolName: 'delete_file', input: {} },
    { tenantId: 'tenant-2', sessionId: 's3', toolCallId: 'c3', toolName: 'send_email', input: {} },
  ]);
  return store;
}

describe('pending approvals for a tenant', () => {
  it('gathers them across conversations', async () => {
    const store = await queue();

    const waiting = await store.pending(TENANT);

    // The point of the port: two different sessions, one inbox.
    expect(waiting.map((approval) => approval.toolName)).toEqual(['send_email', 'delete_file']);
  });

  it('shows another tenant nothing of ours', async () => {
    expect(await (await queue()).pending('tenant-2')).toHaveLength(1);
  });

  it('drops one as soon as it is decided', async () => {
    const store = await queue();
    const [first] = await store.pending(TENANT);
    await store.approve(TENANT, first!.id, { decidedBy: 'yves' });

    const waiting = await store.pending(TENANT);

    // An inbox that keeps decided items is a list nobody trusts.
    expect(waiting.map((approval) => approval.toolName)).toEqual(['delete_file']);
  });

  it('keeps a rejected one out too', async () => {
    const store = await queue();
    const [first] = await store.pending(TENANT);
    await store.reject(TENANT, first!.id, { decidedBy: 'yves', reason: 'wrong recipient' });

    expect(await store.pending(TENANT)).toHaveLength(1);
  });

  it('puts the longest-waiting first', async () => {
    const store = await queue();

    const waiting = await store.pending(TENANT);

    // Each row is a turn parked mid-flight with somebody on the other end, so
    // the one blocked longest is the one to answer.
    expect(waiting[0]?.requestedAt.getTime()).toBeLessThanOrEqual(
      waiting[1]!.requestedAt.getTime(),
    );
  });

  it('caps how many it returns', async () => {
    const store = new InMemoryApprovalStore();
    await store.request(
      Array.from({ length: 10 }, (_unused, index) => ({
        tenantId: TENANT,
        sessionId: `s${String(index)}`,
        toolCallId: `c${String(index)}`,
        toolName: 'send_email',
        input: {},
      })),
    );

    expect(await store.pending(TENANT, 3)).toHaveLength(3);
  });

  it('says nothing is waiting when nothing is', async () => {
    expect(await new InMemoryApprovalStore().pending(TENANT)).toEqual([]);
  });
});
