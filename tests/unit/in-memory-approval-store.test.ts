// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { ApprovalNotPendingError } from '../../src/approval/approval-store.js';
import { InMemoryApprovalStore } from '../../src/approval/in-memory-approval-store.js';

const TENANT = 'tenant-a';
const OTHER = 'tenant-b';
const SESSION = 'session-1';

function req(toolCallId: string, toolName = 'delete_file') {
  return { tenantId: TENANT, sessionId: SESSION, toolCallId, toolName, input: { path: '/x' } };
}

describe('InMemoryApprovalStore', () => {
  it('records pending approvals in order', async () => {
    const store = new InMemoryApprovalStore();

    const created = await store.request([req('call-1'), req('call-2')]);

    expect(created.map((a) => a.toolCallId)).toEqual(['call-1', 'call-2']);
    expect(created.every((a) => a.status === 'pending')).toBe(true);
    expect(created[0]?.decidedBy).toBeNull();
  });

  it('approves a pending row and stamps who decided', async () => {
    const store = new InMemoryApprovalStore();
    const [approval] = await store.request([req('call-1')]);

    const decided = await store.approve(TENANT, approval!.id, { decidedBy: 'yves' });

    expect(decided).toMatchObject({ status: 'approved', decidedBy: 'yves' });
    expect(decided.decidedAt).toBeInstanceOf(Date);
  });

  it('rejects a pending row and keeps the reason for the model', async () => {
    const store = new InMemoryApprovalStore();
    const [approval] = await store.request([req('call-1')]);

    const decided = await store.reject(TENANT, approval!.id, {
      decidedBy: 'yves',
      reason: 'too risky',
    });

    expect(decided).toMatchObject({ status: 'rejected', reason: 'too risky' });
  });

  it('refuses a second decision on the same approval', async () => {
    const store = new InMemoryApprovalStore();
    const [approval] = await store.request([req('call-1')]);
    await store.approve(TENANT, approval!.id, { decidedBy: 'a' });

    await expect(store.reject(TENANT, approval!.id, { decidedBy: 'b' })).rejects.toBeInstanceOf(
      ApprovalNotPendingError,
    );
  });

  it('will not queue the same tool call twice', async () => {
    const store = new InMemoryApprovalStore();
    await store.request([req('call-1')]);

    await expect(store.request([req('call-1')])).rejects.toThrow(/already has an approval/);
  });

  it('does not decide another tenant’s approval', async () => {
    const store = new InMemoryApprovalStore();
    const [approval] = await store.request([req('call-1')]);

    await expect(store.approve(OTHER, approval!.id, { decidedBy: 'x' })).rejects.toBeInstanceOf(
      ApprovalNotPendingError,
    );
    expect((await store.find(TENANT, approval!.id))?.status).toBe('pending');
  });

  it('does not reveal another tenant’s approval', async () => {
    const store = new InMemoryApprovalStore();
    const [approval] = await store.request([req('call-1')]);

    expect(await store.find(OTHER, approval!.id)).toBeNull();
  });

  it('finds the approvals gating a specific turn', async () => {
    const store = new InMemoryApprovalStore();
    await store.request([req('call-1'), req('call-2'), req('call-3')]);

    const found = await store.forToolCalls(TENANT, SESSION, ['call-1', 'call-3']);

    expect(found.map((a) => a.toolCallId).sort()).toEqual(['call-1', 'call-3']);
  });

  it('lists a conversation’s trail oldest first', async () => {
    const store = new InMemoryApprovalStore();
    const [first] = await store.request([req('call-1')]);
    await store.request([req('call-2')]);
    await store.approve(TENANT, first!.id, { decidedBy: 'yves' });

    const trail = await store.list(TENANT, SESSION);

    expect(trail.map((a) => [a.toolCallId, a.status])).toEqual([
      ['call-1', 'approved'],
      ['call-2', 'pending'],
    ]);
  });
});
