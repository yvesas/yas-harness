// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Port: what a workflow run has done so far.
 *
 * A run outlives the process that started it. It stops in the middle to wait
 * for a person, and waiting must cost nothing — no process blocked, no timer,
 * no in-memory queue that a deploy throws away. So every step writes what it
 * produced as it produces it, and resuming is reading rather than remembering.
 * The same reasoning as the agent's approval pause, one level up.
 *
 * It is also the audit trail. A run that posted something answers "which agent
 * wrote this, from which prompt, and who approved it" — and that answer has to
 * survive the workflow file being edited afterwards, which is why each step
 * stores the prompt it actually ran with rather than a pointer to the config.
 */

export type RunStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed';
export type StepStatus = 'running' | 'awaiting_approval' | 'completed' | 'failed' | 'skipped';

/**
 * What a paused step is waiting for.
 *
 * `step` is the workflow's own gate: nothing has run, a person decides whether
 * it should. `tool` is the agent's write gate firing inside the step: the turn
 * is half done, a tool call is held, and resuming continues that turn. Two
 * different resumes, so the run has to know which.
 */
export type AwaitingKind = 'step' | 'tool';

export interface WorkflowRun {
  readonly id: string;
  readonly tenantId: string;
  readonly workflowId: string;
  readonly input: string;
  readonly status: RunStatus;
  /** Why it failed, in the words of whatever failed. */
  readonly error: string | null;
  readonly startedBy: string | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

export interface StepRun {
  readonly id: string;
  readonly runId: string;
  readonly stepId: string;
  readonly agentId: string;
  /** Its own conversation. Null before the step has been allowed to start. */
  readonly sessionId: string | null;
  /** The prompt as rendered, kept because the config can change afterwards. */
  readonly prompt: string;
  readonly output: string | null;
  readonly traceId: string | null;
  readonly status: StepStatus;
  readonly awaiting: AwaitingKind | null;
  /** The queued decision holding it, when the wait is the workflow's own gate. */
  readonly approvalId: string | null;
  readonly error: string | null;
  readonly startedAt: Date;
  readonly finishedAt: Date | null;
}

export interface StartRunInput {
  readonly tenantId: string;
  readonly workflowId: string;
  readonly input: string;
  /** Opaque operator identifier; the harness does not model who that is. */
  readonly startedBy?: string;
}

export interface RecordStepInput {
  readonly tenantId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly status: StepStatus;
  readonly sessionId?: string | null;
  readonly output?: string | null;
  readonly traceId?: string | null;
  readonly awaiting?: AwaitingKind | null;
  readonly approvalId?: string | null;
  readonly error?: string | null;
}

/** How many runs a listing returns unless told otherwise. */
export const DEFAULT_RUN_LIMIT = 30;

export interface WorkflowRunStore {
  start(input: StartRunInput): Promise<WorkflowRun>;
  find(tenantId: string, runId: string): Promise<WorkflowRun | null>;
  /** A tenant's runs, most recent first. */
  list(tenantId: string, limit?: number): Promise<WorkflowRun[]>;
  setStatus(
    tenantId: string,
    runId: string,
    status: RunStatus,
    error?: string | null,
  ): Promise<WorkflowRun>;

  /**
   * Write a step's state, replacing what was there for that step of that run.
   *
   * One row per step per run rather than an append-only log: a step that paused
   * and resumed is one step that took a while, and a reader asking "what did
   * `draft` produce" should not have to work out which of three rows is current.
   */
  recordStep(input: RecordStepInput): Promise<StepRun>;
  steps(tenantId: string, runId: string): Promise<StepRun[]>;
}

export class WorkflowRunError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'WorkflowRunError';
  }
}
