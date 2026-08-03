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

/**
 * What context compression saved on this call, as the harness measured it.
 *
 * Deliberately kept apart from `usage`: those are the provider's own numbers
 * and are exact, while these come from the harness's `TokenCounter` over the
 * request's rendered text — an approximation for any provider whose tokenizer
 * is not the counter's, and blind to whatever framing the provider adds. The
 * point of recording both is to see the saving *next to* the bill it moved,
 * not to pretend they are measured the same way.
 *
 * When a request declares a cacheable prefix the totals cover it too, even
 * though it was never compressed — it was still sent, and leaving it out would
 * read as a larger saving than the call made. That total is two regions counted
 * separately, so it can drift a token from counting the request whole; the
 * counter's own approximation is the larger error by far.
 */
export interface CompressionUsage {
  readonly beforeTokens: number;
  readonly afterTokens: number;
}

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
  /** Absent when no compressor is wired, which is the default posture. */
  readonly compression?: CompressionUsage;
  /**
   * Whose money paid (E3). `platform` unless the tenant brought their own key.
   *
   * Without it a tenant on their own key is indistinguishable from one on ours,
   * and `costUsd` would be billed to them twice — once by their provider and
   * once by us. It stays recorded either way, because what a call *cost* is
   * worth knowing even when it is not ours to charge for.
   */
  readonly billedTo?: BilledTo;
}

/** Which account a call was charged to. */
export type BilledTo = 'platform' | 'tenant';

/**
 * Port: where usage records go.
 *
 * Recording must never break a conversation — an adapter that cannot write
 * should log and move on, not throw into the agent loop.
 */
export interface UsageRecorder {
  record(usage: ModelUsageRecord): Promise<void>;
}

/** What a tenant spent, optionally narrowed to one conversation. */
export interface TenantSpend {
  readonly totalCostUsd: number;
  readonly calls: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * Port: reading spend back.
 *
 * Separate from `UsageRecorder` for the same reason the trace reader is
 * separate from its recorder — the gateway only writes, an operator surface
 * only reads, and neither should have to implement the other half.
 */
export interface UsageReader {
  spend(tenantId: string, sessionId?: string): Promise<TenantSpend>;
}

/** For tests and for running without a database. */
export class InMemoryUsageRecorder implements UsageRecorder, UsageReader {
  readonly records: ModelUsageRecord[] = [];

  record(usage: ModelUsageRecord): Promise<void> {
    this.records.push(usage);
    return Promise.resolve();
  }

  totalCostUsd(): number {
    return this.records.reduce((total, record) => total + record.costUsd, 0);
  }

  spend(tenantId: string, sessionId?: string): Promise<TenantSpend> {
    const matching = this.records.filter(
      (record) =>
        record.tenantId === tenantId && (sessionId === undefined || record.sessionId === sessionId),
    );
    return Promise.resolve({
      totalCostUsd: matching.reduce((total, record) => total + record.costUsd, 0),
      calls: matching.length,
      inputTokens: matching.reduce((total, record) => total + record.usage.inputTokens, 0),
      outputTokens: matching.reduce((total, record) => total + record.usage.outputTokens, 0),
    });
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
