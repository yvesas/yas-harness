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

import type {
  RecentTracesQuery,
  RecordedStep,
  TraceReader,
  TraceRecorder,
  TraceStep,
  TraceSummary,
} from './trace.js';

const DEFAULT_RECENT_LIMIT = 20;

export class PostgresTraceRecorder implements TraceRecorder, TraceReader {
  constructor(private readonly pool: Pool) {}

  async record(step: RecordedStep): Promise<number> {
    const { rows } = await this.pool.query<{ sequence: number }>(
      // The position is computed here rather than sent, because more than one
      // writer contributes to a trace -- the router opens it, the agent
      // continues it -- and each of them counting from zero collides on the
      // first step. The database is the only place that can see both.
      `INSERT INTO traces (
         tenant_id, session_id, trace_id, sequence, kind,
         label, duration_ms, succeeded, detail, error_message
       ) VALUES (
         $1, $2, $3,
         (SELECT coalesce(max(sequence), -1) + 1
            FROM traces WHERE tenant_id = $1 AND trace_id = $3),
         $4, $5, $6, $7, $8, $9
       )
       RETURNING sequence`,
      [
        step.tenantId,
        step.sessionId,
        step.traceId,
        step.kind,
        step.label ?? null,
        step.durationMs ?? null,
        step.succeeded,
        step.detail === undefined ? null : JSON.stringify(step.detail),
        step.errorMessage ?? null,
      ],
    );
    return rows[0]!.sequence;
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

  /**
   * The most recent turns, newest first — one row per turn.
   *
   * Grouped in the database rather than by reading every step and folding in
   * memory: a busy tenant's steps are the one thing here that grows without
   * bound, and a list of turns should not have to load them.
   */
  async recent(tenantId: string, query: RecentTracesQuery = {}): Promise<TraceSummary[]> {
    const { rows } = await this.pool.query<SummaryRow>(
      `SELECT trace_id,
              min(session_id::text)              AS session_id,
              min(created_at)                    AS started_at,
              count(*)::int                      AS steps,
              max(label) FILTER (WHERE kind = 'reply') AS ended_as,
              bool_or(NOT succeeded)             AS failed
         FROM traces
        WHERE tenant_id = $1
          AND ($2::uuid IS NULL OR session_id = $2)
        GROUP BY trace_id
        ORDER BY min(created_at) DESC
        LIMIT $3`,
      [tenantId, query.sessionId ?? null, query.limit ?? DEFAULT_RECENT_LIMIT],
    );

    return rows.map((row) => ({
      traceId: row.trace_id,
      sessionId: row.session_id,
      startedAt: row.started_at,
      steps: row.steps,
      endedAs: row.ended_as,
      failed: row.failed,
    }));
  }
}

interface SummaryRow {
  trace_id: string;
  session_id: string | null;
  started_at: Date;
  steps: number;
  ended_as: string | null;
  failed: boolean;
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
