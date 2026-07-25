// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * What every model call cost, and where that gets written.
 *
 * Cost is derived here rather than in the gateway port: providers price
 * differently, prices change, and the port should not carry either fact.
 */

import type { TaskKind, TokenUsage } from '../models/model-gateway.js';
import type { ModelTier, Price } from '../models/routing.js';

/** One model call, as recorded. */
export interface ModelUsageRecord {
  readonly tenantId: string;
  readonly sessionId: string | null;
  readonly task: TaskKind;
  /** Configuration key of the model that answered, e.g. `anthropic/opus`. */
  readonly modelReference: string;
  readonly provider: string;
  readonly model: string;
  readonly tier: ModelTier;
  readonly usage: TokenUsage;
  readonly costUsd: number;
  readonly latencyMs: number;
  /** How many candidates were tried before this one answered. */
  readonly attempts: number;
  readonly succeeded: boolean;
  readonly errorMessage?: string;
}

/**
 * Port: where usage records go.
 *
 * Recording must never break a conversation — an adapter that cannot write
 * should log and move on, not throw into the agent loop.
 */
export interface UsageRecorder {
  record(usage: ModelUsageRecord): Promise<void>;
}

/** For tests and for running without a database. */
export class InMemoryUsageRecorder implements UsageRecorder {
  readonly records: ModelUsageRecord[] = [];

  record(usage: ModelUsageRecord): Promise<void> {
    this.records.push(usage);
    return Promise.resolve();
  }

  totalCostUsd(): number {
    return this.records.reduce((total, record) => total + record.costUsd, 0);
  }
}

const TOKENS_PER_MTOK = 1_000_000;

/**
 * Cost of one call in USD.
 *
 * Cached input is billed separately and is not part of `inputTokens` — the
 * gateway reports the two apart, so adding them here would double-count.
 */
export function computeCostUsd(usage: TokenUsage, price: Price): number {
  const cost =
    (usage.inputTokens * price.inputPerMTok +
      usage.outputTokens * price.outputPerMTok +
      usage.cachedInputTokens * price.cachedInputPerMTok) /
    TOKENS_PER_MTOK;

  // Sub-cent precision matters: a single call can cost fractions of a cent,
  // and rounding to cents would report most of them as zero.
  return Math.round(cost * 1e8) / 1e8;
}
