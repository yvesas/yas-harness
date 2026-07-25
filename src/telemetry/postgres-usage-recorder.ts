// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: model usage in PostgreSQL.
 *
 * One row per attempt, successful or not — a provider that fails half the
 * time is a fact worth being able to see.
 */

import type { Pool } from 'pg';

import type { ModelUsageRecord, UsageRecorder } from './model-usage.js';

export interface TenantSpend {
  readonly totalCostUsd: number;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

export class PostgresUsageRecorder implements UsageRecorder {
  constructor(private readonly pool: Pool) {}

  async record(usage: ModelUsageRecord): Promise<void> {
    await this.pool.query(
      `INSERT INTO model_usage (
         tenant_id, session_id, task, model_reference, provider, model, tier,
         input_tokens, output_tokens, cached_input_tokens, cost_usd,
         latency_ms, attempts, succeeded, error_message
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
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
}
