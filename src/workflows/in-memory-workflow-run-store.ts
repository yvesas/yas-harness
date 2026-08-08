// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Runs held in memory, for tests and for a product trying a workflow out.
 *
 * Beside the in-memory session and approval stores, and for the same reason: a
 * run that pauses for a person is worth proving without a database, and the
 * proof is only worth having if the fake obeys the same rules — tenant scoping
 * on every read, one row per step of a run, and a status that says the same
 * thing the SQL check constraint says.
 *
 * Everything is lost when the process ends, so it is not a deployment choice.
 */

import { randomUUID } from 'node:crypto';

import {
  DEFAULT_RUN_LIMIT,
  WorkflowRunError,
  type RecordStepInput,
  type RunStatus,
  type StartRunInput,
  type StepRun,
  type WorkflowRun,
  type WorkflowRunStore,
} from './workflow-run-store.js';

export class InMemoryWorkflowRunStore implements WorkflowRunStore {
  readonly #runs = new Map<string, WorkflowRun>();
  readonly #steps = new Map<string, StepRun[]>();

  start(input: StartRunInput): Promise<WorkflowRun> {
    const run: WorkflowRun = {
      id: randomUUID(),
      tenantId: input.tenantId,
      workflowId: input.workflowId,
      input: input.input,
      status: 'running',
      error: null,
      startedBy: input.startedBy ?? null,
      startedAt: new Date(),
      finishedAt: null,
    };
    this.#runs.set(run.id, run);
    this.#steps.set(run.id, []);
    return Promise.resolve(run);
  }

  find(tenantId: string, runId: string): Promise<WorkflowRun | null> {
    const run = this.#runs.get(runId);
    // The tenant check is not a formality here either: an id is not an
    // authorisation, and a fake that skipped it would let a test pass that the
    // database would fail.
    return Promise.resolve(run && run.tenantId === tenantId ? run : null);
  }

  list(tenantId: string, limit = DEFAULT_RUN_LIMIT): Promise<WorkflowRun[]> {
    const runs = [...this.#runs.values()]
      .filter((run) => run.tenantId === tenantId)
      .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())
      .slice(0, limit);
    return Promise.resolve(runs);
  }

  setStatus(
    tenantId: string,
    runId: string,
    status: RunStatus,
    error: string | null = null,
  ): Promise<WorkflowRun> {
    const run = this.#runs.get(runId);
    if (!run || run.tenantId !== tenantId) {
      throw new WorkflowRunError(`run "${runId}" not found for tenant "${tenantId}"`);
    }
    const finished = status === 'completed' || status === 'failed';
    const updated: WorkflowRun = {
      ...run,
      status,
      error: finished ? error : null,
      finishedAt: finished ? new Date() : null,
    };
    this.#runs.set(runId, updated);
    return Promise.resolve(updated);
  }

  recordStep(input: RecordStepInput): Promise<StepRun> {
    const run = this.#runs.get(input.runId);
    if (!run || run.tenantId !== input.tenantId) {
      throw new WorkflowRunError(`run "${input.runId}" not found for tenant "${input.tenantId}"`);
    }
    const steps = this.#steps.get(input.runId) ?? [];
    const existing = steps.find((step) => step.stepId === input.stepId);
    const finished = input.status === 'completed' || input.status === 'failed';

    const step: StepRun = {
      id: existing?.id ?? randomUUID(),
      runId: input.runId,
      stepId: input.stepId,
      agentId: input.agentId,
      // Kept when the update does not carry one, like the upsert's coalesce.
      sessionId: input.sessionId ?? existing?.sessionId ?? null,
      prompt: input.prompt,
      output: input.output ?? existing?.output ?? null,
      traceId: input.traceId ?? existing?.traceId ?? null,
      status: input.status,
      awaiting: input.awaiting ?? null,
      approvalId: input.approvalId ?? null,
      error: input.error ?? null,
      startedAt: existing?.startedAt ?? new Date(),
      finishedAt: finished ? new Date() : null,
    };

    if (existing) {
      steps[steps.indexOf(existing)] = step;
    } else {
      steps.push(step);
    }
    this.#steps.set(input.runId, steps);
    return Promise.resolve(step);
  }

  steps(tenantId: string, runId: string): Promise<StepRun[]> {
    const run = this.#runs.get(runId);
    if (!run || run.tenantId !== tenantId) {
      return Promise.resolve([]);
    }
    return Promise.resolve([...(this.#steps.get(runId) ?? [])]);
  }
}
