// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: model usage in PostgreSQL.
 *
 * One row per attempt, successful or not — a provider that fails half the
 * time is a fact worth being able to see.
 */

import type { Pool } from 'pg';

import type {
  CompressionSavings,
  ModelUsageRecord,
  SpendDimension,
  SpendQuery,
  SpendSlice,
  TenantSpend,
  UsageReader,
  UsageRecorder,
} from './model-usage.js';
import { DEFAULT_BREAKDOWN_LIMIT } from './model-usage.js';

export class PostgresUsageRecorder implements UsageRecorder, UsageReader {
  constructor(private readonly pool: Pool) {}

  async record(usage: ModelUsageRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO model_usage (
         tenant_id, session_id, task, model_reference, provider, model, tier,
         input_tokens, output_tokens, cached_input_tokens, cost_usd,
         latency_ms, attempts, succeeded, error_message,
         compression_before_tokens, compression_after_tokens, billed_to
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18)`,
      [
        usage.tenantId,
        usage.sessionId,
        usage.task,
        usage.modelReference,
        usage.provider,
        usage.model,
        usage.tier,
        usage.usage.inputTokens,
        usage.usage.outputTokens,
        usage.usage.cachedInputTokens,
        usage.costUsd,
        usage.latencyMs,
        usage.attempts,
        usage.succeeded,
        usage.errorMessage ?? null,
        usage.compression?.beforeTokens ?? null,
        usage.compression?.afterTokens ?? null,
        // Defaulted here, not in the caller: a record written before BYOM
        // existed was the platform's, and so is one from a gateway with no
        // key resolver wired.
        usage.billedTo ?? 'platform',
      ],
    );
  }

  /** What a tenant spent, optionally narrowed to one conversation. */
  async spend(tenantId: string, sessionId?: string): Promise<TenantSpend> {
    const { rows } = await this.pool.query<{
      total_cost_usd: string;
      calls: string;
      input_tokens: string;
      output_tokens: string;
    }>(
      `SELECT coalesce(sum(cost_usd), 0)::text     AS total_cost_usd,
              count(*)::text                        AS calls,
              coalesce(sum(input_tokens), 0)::text  AS input_tokens,
              coalesce(sum(output_tokens), 0)::text AS output_tokens
         FROM model_usage
        WHERE tenant_id = $1
          AND ($2::uuid IS NULL OR session_id = $2)`,
      [tenantId, sessionId ?? null],
    );

    const row = rows[0]!;
    return {
      totalCostUsd: Number(row.total_cost_usd),
      calls: Number(row.calls),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
    };
  }

  async breakdown(tenantId: string, query: SpendQuery): Promise<SpendSlice[]> {
    // The dimension is a lookup, never interpolation. This is the query an
    // operator surface drives from a URL, so the grouping must be something
    // this file chose rather than something a caller wrote.
    const grouping = GROUPING[query.by];

    const { rows } = await this.pool.query<SliceRow>(
      `SELECT ${grouping}                                    AS key,
              coalesce(sum(cost_usd), 0)::text               AS cost_usd,
              count(*)::text                                 AS calls,
              coalesce(sum(input_tokens), 0)::text           AS input_tokens,
              coalesce(sum(output_tokens), 0)::text          AS output_tokens,
              coalesce(sum(cached_input_tokens), 0)::text    AS cached_input_tokens
         FROM model_usage
        WHERE tenant_id = $1
          AND ($2::timestamptz IS NULL OR created_at >= $2)
          -- Exclusive, so two consecutive ranges cannot both claim a row on
          -- the boundary and report the same money twice.
          AND ($3::timestamptz IS NULL OR created_at < $3)
          AND ${grouping} IS NOT NULL
        GROUP BY 1
        ORDER BY sum(cost_usd) DESC
        LIMIT $4`,
      [tenantId, query.from ?? null, query.to ?? null, query.limit ?? DEFAULT_BREAKDOWN_LIMIT],
    );

    return rows.map((row) => ({
      key: row.key,
      costUsd: Number(row.cost_usd),
      calls: Number(row.calls),
      inputTokens: Number(row.input_tokens),
      outputTokens: Number(row.output_tokens),
      cachedInputTokens: Number(row.cached_input_tokens),
    }));
  }

  async savings(tenantId: string): Promise<CompressionSavings | null> {
    const { rows } = await this.pool.query<{
      calls: string;
      before_tokens: string;
      after_tokens: string;
    }>(
      `SELECT count(*)::text                                     AS calls,
              coalesce(sum(compression_before_tokens), 0)::text  AS before_tokens,
              coalesce(sum(compression_after_tokens), 0)::text   AS after_tokens
         FROM model_usage
        WHERE tenant_id = $1
          AND compression_before_tokens IS NOT NULL`,
      [tenantId],
    );

    const row = rows[0]!;
    // Null rather than zeroes: "compression was never on" and "compression
    // saved nothing" are different answers, and a page should be able to say
    // which one it is.
    return Number(row.calls) === 0
      ? null
      : {
          calls: Number(row.calls),
          beforeTokens: Number(row.before_tokens),
          afterTokens: Number(row.after_tokens),
        };
  }
}

interface SliceRow {
  key: string;
  cost_usd: string;
  calls: string;
  input_tokens: string;
  output_tokens: string;
  cached_input_tokens: string;
}

/**
 * The one place a dimension becomes SQL.
 *
 * `session_id` is cast because the column is a uuid and every other grouping is
 * text; a breakdown returns one shape whatever it grouped by. Rows with a null
 * key are excluded by the query rather than bucketed — a call made outside a
 * conversation belongs to no session, and inventing one to hold it would be a
 * row nobody can click through to.
 */
const GROUPING: Record<SpendDimension, string> = {
  model: 'model_reference',
  task: 'task',
  session: 'session_id::text',
  // UTC, and stated as such: a day boundary in the server's local time is a
  // number that changes meaning when the deployment moves.
  day: "to_char(date_trunc('day', created_at AT TIME ZONE 'UTC'), 'YYYY-MM-DD')",
};
