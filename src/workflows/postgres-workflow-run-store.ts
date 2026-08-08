// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: workflow runs in PostgreSQL.
 *
 * Every statement carries the tenant, including the ones that already know the
 * run id — an id is not an authorisation, and a run id that leaked must not be
 * a way to read another tenant's work.
 */

import type { Pool } from 'pg';

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

interface RunRow {
  id: string;
  tenant_id: string;
  workflow_id: string;
  input: string;
  status: RunStatus;
  error: string | null;
  started_by: string | null;
  started_at: Date;
  finished_at: Date | null;
}

interface StepRow {
  id: string;
  run_id: string;
  step_id: string;
  agent_id: string;
  session_id: string | null;
  prompt: string;
  output: string | null;
  trace_id: string | null;
  status: StepRun['status'];
  awaiting: StepRun['awaiting'];
  approval_id: string | null;
  error: string | null;
  started_at: Date;
  finished_at: Date | null;
}

/** The statuses after which nothing more happens. */
const TERMINAL = new Set<RunStatus>(['completed', 'failed']);

export class PostgresWorkflowRunStore implements WorkflowRunStore {
  readonly #pool: Pool;

  constructor(pool: Pool) {
    this.#pool = pool;
  }

  async start(input: StartRunInput): Promise<WorkflowRun> {
    const { rows } = await this.#pool.query<RunRow>(
      `INSERT INTO workflow_runs (tenant_id, workflow_id, input, started_by)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [input.tenantId, input.workflowId, input.input, input.startedBy ?? null],
    );
    return toRun(rows[0]!);
  }

  async find(tenantId: string, runId: string): Promise<WorkflowRun | null> {
    const { rows } = await this.#pool.query<RunRow>(
      'SELECT * FROM workflow_runs WHERE id = $1 AND tenant_id = $2',
      [runId, tenantId],
    );
    return rows[0] ? toRun(rows[0]) : null;
  }

  async list(tenantId: string, limit = DEFAULT_RUN_LIMIT): Promise<WorkflowRun[]> {
    const { rows } = await this.#pool.query<RunRow>(
      `SELECT * FROM workflow_runs
        WHERE tenant_id = $1
        ORDER BY started_at DESC
        LIMIT $2`,
      [tenantId, limit],
    );
    return rows.map(toRun);
  }

  async setStatus(
    tenantId: string,
    runId: string,
    status: RunStatus,
    error: string | null = null,
  ): Promise<WorkflowRun> {
    const { rows } = await this.#pool.query<RunRow>(
      `UPDATE workflow_runs
          SET status = $3,
              error = $4,
              -- Stamped by the database when the run reaches an end, so a
              -- finished run cannot be one whose clock said otherwise.
              finished_at = CASE WHEN $3 IN ('completed', 'failed') THEN now() ELSE NULL END
        WHERE id = $1 AND tenant_id = $2
        RETURNING *`,
      [runId, tenantId, status, TERMINAL.has(status) ? error : null],
    );
    const row = rows[0];
    if (!row) {
      throw new WorkflowRunError(`run "${runId}" not found for tenant "${tenantId}"`);
    }
    return toRun(row);
  }

  async recordStep(input: RecordStepInput): Promise<StepRun> {
    const finished = input.status === 'completed' || input.status === 'failed';
    const { rows } = await this.#pool.query<StepRow>(
      `INSERT INTO workflow_run_steps
         (tenant_id, run_id, step_id, agent_id, session_id, prompt, output,
          trace_id, status, awaiting, approval_id, error, finished_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
               CASE WHEN $13 THEN now() ELSE NULL END)
       ON CONFLICT (run_id, step_id)
       DO UPDATE SET agent_id = excluded.agent_id,
                     -- Kept when the update does not carry one: a resume knows
                     -- the outcome without re-deriving the session it ran in.
                     session_id = coalesce(excluded.session_id, workflow_run_steps.session_id),
                     prompt = excluded.prompt,
                     output = coalesce(excluded.output, workflow_run_steps.output),
                     trace_id = coalesce(excluded.trace_id, workflow_run_steps.trace_id),
                     status = excluded.status,
                     awaiting = excluded.awaiting,
                     approval_id = excluded.approval_id,
                     error = excluded.error,
                     finished_at = excluded.finished_at
       RETURNING *`,
      [
        input.tenantId,
        input.runId,
        input.stepId,
        input.agentId,
        input.sessionId ?? null,
        input.prompt,
        input.output ?? null,
        input.traceId ?? null,
        input.status,
        input.awaiting ?? null,
        input.approvalId ?? null,
        input.error ?? null,
        finished,
      ],
    );
    return toStep(rows[0]!);
  }

  async steps(tenantId: string, runId: string): Promise<StepRun[]> {
    const { rows } = await this.#pool.query<StepRow>(
      `SELECT * FROM workflow_run_steps
        WHERE tenant_id = $1 AND run_id = $2
        ORDER BY started_at`,
      [tenantId, runId],
    );
    return rows.map(toStep);
  }
}

function toRun(row: RunRow): WorkflowRun {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    workflowId: row.workflow_id,
    input: row.input,
    status: row.status,
    error: row.error,
    startedBy: row.started_by,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

function toStep(row: StepRow): StepRun {
  return {
    id: row.id,
    runId: row.run_id,
    stepId: row.step_id,
    agentId: row.agent_id,
    sessionId: row.session_id,
    prompt: row.prompt,
    output: row.output,
    traceId: row.trace_id,
    status: row.status,
    awaiting: row.awaiting,
    approvalId: row.approval_id,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}
