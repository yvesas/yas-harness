// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: trace steps in PostgreSQL.
 *
 * One row per step, appended as the turn runs rather than at the end — a turn
 * that crashes half way should still show how far it got, which is exactly when
 * a trace is worth having.
 */

import type { Pool } from 'pg';

import type { TraceRecorder, TraceStep } from './trace.js';

export class PostgresTraceRecorder implements TraceRecorder {
  constructor(private readonly pool: Pool) {}

  async record(step: TraceStep): Promise<void> {
    await this.pool.query(
      `INSERT INTO traces (
         tenant_id, session_id, trace_id, sequence, kind,
         label, duration_ms, succeeded, detail, error_message
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [
        step.tenantId,
        step.sessionId,
        step.traceId,
        step.sequence,
        step.kind,
        step.label ?? null,
        step.durationMs ?? null,
        step.succeeded,
        step.detail === undefined ? null : JSON.stringify(step.detail),
        step.errorMessage ?? null,
      ],
    );
  }

  /** One turn's steps, in order — the query a trace exists for. */
  async trace(tenantId: string, traceId: string): Promise<TraceStep[]> {
    const { rows } = await this.pool.query<TraceRow>(
      `SELECT tenant_id, session_id, trace_id, sequence, kind,
              label, duration_ms, succeeded, detail, error_message
         FROM traces
        WHERE tenant_id = $1 AND trace_id = $2
        ORDER BY sequence`,
      [tenantId, traceId],
    );
    return rows.map(toStep);
  }
}

interface TraceRow {
  tenant_id: string;
  session_id: string | null;
  trace_id: string;
  sequence: number;
  kind: string;
  label: string | null;
  duration_ms: number | null;
  succeeded: boolean;
  detail: Record<string, unknown> | null;
  error_message: string | null;
}

function toStep(row: TraceRow): TraceStep {
  return {
    tenantId: row.tenant_id,
    sessionId: row.session_id,
    traceId: row.trace_id,
    sequence: row.sequence,
    kind: row.kind as TraceStep['kind'],
    succeeded: row.succeeded,
    ...(row.label === null ? {} : { label: row.label }),
    ...(row.duration_ms === null ? {} : { durationMs: row.duration_ms }),
    ...(row.detail === null ? {} : { detail: row.detail }),
    ...(row.error_message === null ? {} : { errorMessage: row.error_message }),
  };
}
