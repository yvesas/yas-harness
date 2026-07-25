// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The gateway proper: pick a model for the task, retry, fall back, record.
 *
 * This is the piece the agent loop actually talks to. Providers below it do
 * one call and nothing else; the core above it never learns which model
 * answered.
 */

import type { ModelUsageRecord, UsageRecorder } from '../telemetry/model-usage.js';
import { computeCostUsd } from '../telemetry/model-usage.js';

import type { ModelGateway, ModelRequest, ModelResponse, TaskKind } from './model-gateway.js';
import { ModelGatewayError } from './model-gateway.js';
import type { ModelProvider } from './model-provider.js';
import type { ModelConfig, ResolvedCandidate } from './routing.js';
import { candidatesFor } from './routing.js';

export interface RoutedGatewayOptions {
  readonly config: ModelConfig;
  readonly providers: readonly ModelProvider[];
  readonly recorder?: UsageRecorder;
  /** Attributed to every usage record; a product supplies the real tenant. */
  readonly tenantId?: string;
  /** Injected in tests so backoff does not make the suite slow. */
  readonly sleep?: (ms: number) => Promise<void>;
}

const UNATTRIBUTED_TENANT = 'unattributed';
const BACKOFF_BASE_MS = 250;

export class RoutedGateway implements ModelGateway {
  readonly #config: ModelConfig;
  readonly #providers: Map<string, ModelProvider>;
  readonly #recorder: UsageRecorder | undefined;
  readonly #tenantId: string;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(options: RoutedGatewayOptions) {
    this.#config = options.config;
    this.#providers = new Map(options.providers.map((provider) => [provider.name, provider]));
    this.#recorder = options.recorder;
    this.#tenantId = options.tenantId ?? UNATTRIBUTED_TENANT;
    this.#sleep = options.sleep ?? defaultSleep;

    // A route pointing at a provider nobody registered is a wiring mistake
    // that would otherwise surface only when that fallback is finally needed.
    for (const task of ['routing', 'simple', 'reasoning', 'sensitive'] as const) {
      for (const candidate of candidatesFor(this.#config, task)) {
        if (!this.#providers.has(candidate.provider)) {
          throw new ModelGatewayError(
            `route "${task}" uses model "${candidate.reference}" from unregistered provider "${candidate.provider}"`,
            { provider: candidate.provider, task, retryable: false },
          );
        }
      }
    }
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    const candidates = candidatesFor(this.#config, request.task);
    let attempts = 0;
    let lastError: ModelGatewayError | undefined;

    for (const candidate of candidates) {
      for (let attempt = 1; attempt <= this.#config.attemptsPerModel; attempt += 1) {
        attempts += 1;
        const startedAt = performance.now();

        try {
          const response = await this.#invoke(candidate, request);
          await this.#record(candidate, request, {
            usage: response.usage,
            latencyMs: response.latencyMs,
            attempts,
            succeeded: true,
          });
          return response;
        } catch (error) {
          const failure = asGatewayError(error, candidate, request.task);
          lastError = failure;

          await this.#record(candidate, request, {
            usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
            latencyMs: Math.round(performance.now() - startedAt),
            attempts,
            succeeded: false,
            errorMessage: failure.message,
          });

          // A rejected request fails the same way however often it is sent;
          // only transient failures are worth another attempt or another
          // provider.
          if (!failure.detail.retryable) {
            throw failure;
          }
          if (attempt < this.#config.attemptsPerModel) {
            await this.#sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
          }
        }
      }
    }

    throw new ModelGatewayError(
      `every model for task "${request.task}" failed after ${attempts} attempt(s): ${lastError?.message ?? 'no candidates'}`,
      { provider: 'routed', task: request.task, retryable: true },
      lastError ? { cause: lastError } : {},
    );
  }

  async #invoke(candidate: ResolvedCandidate, request: ModelRequest): Promise<ModelResponse> {
    const provider = this.#providers.get(candidate.provider)!;
    return provider.invoke({
      model: candidate.model,
      request,
      signal: AbortSignal.timeout(this.#config.requestTimeoutMs),
    });
  }

  async #record(
    candidate: ResolvedCandidate,
    request: ModelRequest,
    outcome: Pick<
      ModelUsageRecord,
      'usage' | 'latencyMs' | 'attempts' | 'succeeded' | 'errorMessage'
    >,
  ): Promise<void> {
    if (!this.#recorder) {
      return;
    }

    const record: ModelUsageRecord = {
      tenantId: request.attribution?.tenantId ?? this.#tenantId,
      sessionId: request.attribution?.sessionId ?? null,
      task: request.task,
      modelReference: candidate.reference,
      provider: candidate.provider,
      model: candidate.model,
      tier: candidate.tier,
      costUsd: computeCostUsd(outcome.usage, candidate.price),
      ...outcome,
    };

    try {
      await this.#recorder.record(record);
    } catch (error) {
      // Losing a usage row is a billing-visibility problem; failing the user's
      // turn over it would be worse.
      console.warn('failed to record model usage', {
        model: record.modelReference,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

function asGatewayError(
  error: unknown,
  candidate: ResolvedCandidate,
  task: TaskKind,
): ModelGatewayError {
  if (error instanceof ModelGatewayError) {
    return error;
  }

  // A timeout is the gateway's own deadline firing, which is retryable by
  // definition — the next candidate gets a fresh one.
  const timedOut = error instanceof Error && error.name === 'TimeoutError';
  const message = error instanceof Error ? error.message : String(error);

  return new ModelGatewayError(`${candidate.reference} failed: ${message}`, {
    provider: candidate.provider,
    task,
    retryable: timedOut,
  });
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
