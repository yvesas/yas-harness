// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Port: the queue of actions waiting for a human to approve.
 *
 * When a tool marked `requiresApproval` is called, the agent does not run it —
 * it records a pending approval here and stops. A human decides; the agent
 * resumes. The store is the whole state of a paused turn, which is what lets
 * the pause cost nothing: no process blocks, no timer waits.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected';

/** One tool call held for a decision. */
export interface Approval {
  readonly id: string;
  readonly tenantId: string;
  readonly sessionId: string;
  /** The tool call this decision gates, from the assistant turn. */
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  readonly status: ApprovalStatus;
  readonly requestedAt: Date;
  /** Opaque operator identifier; the harness does not model who that is. */
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  /** Why it was rejected, shown back to the model. */
  readonly reason: string | null;
}

export interface RequestApprovalInput {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
}

export interface Decision {
  readonly decidedBy: string;
  /** Optional note; on a rejection it reaches the model as the reason. */
  readonly reason?: string;
}

export class ApprovalError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ApprovalError';
  }
}

/** Raised when deciding an approval that is not pending, or does not exist. */
export class ApprovalNotPendingError extends ApprovalError {
  constructor(id: string) {
    super(`approval "${id}" is not pending`);
    this.name = 'ApprovalNotPendingError';
  }
}

/**
 * Every method is scoped by tenant: there is no decision or read that crosses
 * the tenant boundary.
 */
export interface ApprovalStore {
  /** Record pending approvals for a turn; returns them in the given order. */
  request(inputs: readonly RequestApprovalInput[]): Promise<Approval[]>;
  find(tenantId: string, id: string): Promise<Approval | null>;
  /** The approvals gating a specific assistant turn, by its tool-call ids. */
  forToolCalls(
    tenantId: string,
    sessionId: string,
    toolCallIds: readonly string[],
  ): Promise<Approval[]>;
  approve(tenantId: string, id: string, decision: Decision): Promise<Approval>;
  reject(tenantId: string, id: string, decision: Decision): Promise<Approval>;
  /** The audit trail for a conversation: what was asked, decided, and by whom. */
  list(tenantId: string, sessionId: string): Promise<Approval[]>;
}
