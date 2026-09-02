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

/**
 * The three ways a decision can land, and the one that was missing.
 *
 * `changes_requested` is not a softer rejection. A rejection ends the attempt:
 * the model is told no and moves on. This says *do it differently* and carries
 * the correction back into the turn, which is the answer a reviewer usually
 * has — the action was right and the arguments were not. Without it, the only
 * way to ask for a smaller blast radius was to reject and hope the model
 * guessed what to change.
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'changes_requested';

/**
 * How much damage running this would do if it were wrong.
 *
 * Declared by whoever gated the call, not judged from the tool name. It orders
 * an inbox and nothing else — the harness never decides on a reviewer's behalf,
 * whatever the level.
 */
export type Risk = 'none' | 'low' | 'medium' | 'high';

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
  readonly risk: Risk;
  /**
   * What running this would do, in a sentence a person can act on.
   *
   * *"Sends a real email to 214 recipients"* — not `send_email`, which the
   * reviewer already sees and which tells them nothing about the blast radius.
   * A reviewer approving on the tool name alone is rubber-stamping, and a queue
   * that only shows the tool name has asked them to.
   */
  readonly consequence: string | null;
  /** Which rule held this call, so a surprising gate can be traced to its cause. */
  readonly policySource: string | null;
  readonly requestedAt: Date;
  /** Opaque operator identifier; the harness does not model who that is. */
  readonly decidedBy: string | null;
  readonly decidedAt: Date | null;
  /** Why it was rejected, or what to change. Reaches the model either way. */
  readonly reason: string | null;
}

export interface RequestApprovalInput {
  readonly tenantId: string;
  readonly sessionId: string;
  readonly toolCallId: string;
  readonly toolName: string;
  readonly input: unknown;
  /** Defaults to `medium`: a gated call nobody rated is not a safe one. */
  readonly risk?: Risk;
  readonly consequence?: string;
  readonly policySource?: string;
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
/** How many waiting decisions a listing returns unless told otherwise. */
export const DEFAULT_PENDING_LIMIT = 50;

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
  /**
   * Send it back to be done differently.
   *
   * `reason` is required here, unlike on the other two: "changes requested"
   * with no note is a dead end for the model, which knows only that its
   * arguments were wrong and not which one.
   */
  requestChanges(
    tenantId: string,
    id: string,
    decision: Decision & { reason: string },
  ): Promise<Approval>;
  /** The audit trail for a conversation: what was asked, decided, and by whom. */
  list(tenantId: string, sessionId: string): Promise<Approval[]>;
  /**
   * Everything this tenant is waiting on, oldest first.
   *
   * `list` answers about one conversation, which is only useful to somebody who
   * already knows which conversation to look at. A person deciding does not:
   * they have an inbox, and the question is "what is waiting for me". Oldest
   * first because that is the one that has been blocked longest — a turn is
   * parked until this is answered.
   */
  pending(tenantId: string, limit?: number): Promise<Approval[]>;
  /**
   * The tenant's approvals whatever their status, newest first.
   *
   * `pending` answers "what is blocked on me". This answers the question an
   * inbox asks either side of that: what did I already decide, and what did I
   * send back that the agent has not returned yet. Newest first because a
   * decided row is history — the useful end is the recent one, which is the
   * opposite of `pending`, where the useful end is the one blocked longest.
   */
  recent(tenantId: string, limit?: number): Promise<Approval[]>;
}
