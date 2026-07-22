// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: the approval queue in process memory.
 *
 * For tests and for running without a database. It enforces the same rules the
 * Postgres adapter does: tenant scoping, one decision per tool call, and no
 * deciding an approval that is not pending.
 */

import type { Approval, ApprovalStore, Decision, RequestApprovalInput } from './approval-store.js';
import { ApprovalError, ApprovalNotPendingError } from './approval-store.js';

// Async on purpose despite doing no I/O: it matches the Postgres adapter's
// shape, so a rejected decision is a rejected promise, not a synchronous throw.
/* eslint-disable @typescript-eslint/require-await */

export class InMemoryApprovalStore implements ApprovalStore {
  readonly #approvals = new Map<string, Approval>();
  #clock = 0;

  async request(inputs: readonly RequestApprovalInput[]): Promise<Approval[]> {
    const created: Approval[] = [];
    for (const input of inputs) {
      if (this.#findToolCall(input.sessionId, input.toolCallId)) {
        throw new ApprovalError(
          `tool call "${input.toolCallId}" already has an approval in session "${input.sessionId}"`,
        );
      }
      this.#clock += 1;
      const approval: Approval = {
        id: `approval-${this.#clock}`,
        tenantId: input.tenantId,
        sessionId: input.sessionId,
        toolCallId: input.toolCallId,
        toolName: input.toolName,
        input: structuredClone(input.input),
        status: 'pending',
        requestedAt: new Date(this.#clock * 1000),
        decidedBy: null,
        decidedAt: null,
        reason: null,
      };
      this.#approvals.set(approval.id, approval);
      created.push(approval);
    }
    return created;
  }

  async find(tenantId: string, id: string): Promise<Approval | null> {
    const approval = this.#approvals.get(id);
    return approval && approval.tenantId === tenantId ? approval : null;
  }

  async forToolCalls(
    tenantId: string,
    sessionId: string,
    toolCallIds: readonly string[],
  ): Promise<Approval[]> {
    const wanted = new Set(toolCallIds);
    return [...this.#approvals.values()].filter(
      (approval) =>
        approval.tenantId === tenantId &&
        approval.sessionId === sessionId &&
        wanted.has(approval.toolCallId),
    );
  }

  approve(tenantId: string, id: string, decision: Decision): Promise<Approval> {
    return this.#decide(tenantId, id, 'approved', decision);
  }

  reject(tenantId: string, id: string, decision: Decision): Promise<Approval> {
    return this.#decide(tenantId, id, 'rejected', decision);
  }

  async list(tenantId: string, sessionId: string): Promise<Approval[]> {
    return [...this.#approvals.values()]
      .filter((approval) => approval.tenantId === tenantId && approval.sessionId === sessionId)
      .sort((a, b) => a.requestedAt.getTime() - b.requestedAt.getTime());
  }

  async #decide(
    tenantId: string,
    id: string,
    status: 'approved' | 'rejected',
    decision: Decision,
  ): Promise<Approval> {
    const approval = this.#approvals.get(id);
    if (!approval || approval.tenantId !== tenantId || approval.status !== 'pending') {
      throw new ApprovalNotPendingError(id);
    }
    this.#clock += 1;
    const decided: Approval = {
      ...approval,
      status,
      decidedBy: decision.decidedBy,
      decidedAt: new Date(this.#clock * 1000),
      reason: decision.reason ?? null,
    };
    this.#approvals.set(id, decided);
    return decided;
  }

  #findToolCall(sessionId: string, toolCallId: string): Approval | undefined {
    return [...this.#approvals.values()].find(
      (approval) => approval.sessionId === sessionId && approval.toolCallId === toolCallId,
    );
  }
}
