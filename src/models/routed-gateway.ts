// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The gateway proper: pick a model for the task, retry, fall back, record.
 *
 * This is the piece the agent loop actually talks to. Providers below it do
 * one call and nothing else; the core above it never learns which model
 * answered.
 */

import type { ContextCompressor } from '../compression/context-compressor.js';
import type { Availability, Unavailable } from './availability.js';
import { InMemoryAvailability, credentialScope, providerScope } from './availability.js';
import type { SecretRedactor } from '../redaction/secret-redactor.js';
import type {
  CompressionUsage,
  ModelUsageRecord,
  UsageRecorder,
} from '../telemetry/model-usage.js';
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
  /**
   * Shrinks a request's context before it goes out (E5.5). Omitted by default:
   * compression enters the data path only once a product's eval says its
   * answers do not degrade, and the harness ships it off.
   */
  readonly compressor?: ContextCompressor;
  /** Attributed to every usage record; a product supplies the real tenant. */
  readonly tenantId?: string;
  /** Scrubs secrets from the one thing this class logs; wired in production. */
  readonly redactor?: SecretRedactor;
  /** Injected in tests so backoff does not make the suite slow. */
  readonly sleep?: (ms: number) => Promise<void>;
  /**
   * Remembers what is broken, so the next request does not rediscover it.
   * Defaults to an in-process one — it only engages after repeated failures,
   * so leaving it on costs a healthy deployment nothing.
   */
  readonly availability?: Availability;
  /** Injected in tests; defaults to the wall clock. */
  readonly now?: () => Date;
}

const UNATTRIBUTED_TENANT = 'unattributed';
const BACKOFF_BASE_MS = 250;

export class RoutedGateway implements ModelGateway {
  readonly #config: ModelConfig;
  readonly #providers: Map<string, ModelProvider>;
  readonly #recorder: UsageRecorder | undefined;
  readonly #compressor: ContextCompressor | undefined;
  readonly #tenantId: string;
  readonly #redactor: SecretRedactor;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #availability: Availability;
  readonly #now: () => Date;

  constructor(options: RoutedGatewayOptions) {
    this.#config = options.config;
    this.#providers = new Map(options.providers.map((provider) => [provider.name, provider]));
    this.#recorder = options.recorder;
    this.#compressor = options.compressor;
    this.#tenantId = options.tenantId ?? UNATTRIBUTED_TENANT;
    // No redactor in tests means log as-is; production always wires the real one.
    this.#redactor = options.redactor ?? { redact: (text) => text };
    this.#sleep = options.sleep ?? defaultSleep;
    this.#availability = options.availability ?? new InMemoryAvailability();
    this.#now = options.now ?? (() => new Date());

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
    // Compressed once, before the chain rather than inside it: every candidate
    // is sent the same context, and the pipeline is deterministic, so running
    // it per attempt would only repeat work and muddle what a retry cost.
    const { request: outgoing, compression } = this.#compress(request);
    const recorded = compression ? { compression } : {};

    const candidates = candidatesFor(this.#config, outgoing.task);
    const tenantId = outgoing.attribution?.tenantId ?? this.#tenantId;
    let attempts = 0;
    let lastError: ModelGatewayError | undefined;
    const skipped: Unavailable[] = [];

    for (const candidate of candidates) {
      // Skipping is the whole point: a provider known to be down should not be
      // rediscovered, with a full timeout, on every request of every turn.
      const unavailable = this.#unavailable(candidate, tenantId);
      if (unavailable) {
        skipped.push(unavailable);
        continue;
      }

      for (let attempt = 1; attempt <= this.#config.attemptsPerModel; attempt += 1) {
        attempts += 1;
        const startedAt = performance.now();

        try {
          const response = await this.#invoke(candidate, outgoing);
          this.#availability.recordSuccess(providerScope(candidate.provider));
          this.#availability.recordSuccess(credentialScope(tenantId, candidate.reference));
          await this.#record(candidate, outgoing, {
            usage: response.usage,
            latencyMs: response.latencyMs,
            attempts,
            succeeded: true,
            ...recorded,
          });
          return response;
        } catch (error) {
          const failure = asGatewayError(error, candidate, outgoing.task);
          lastError = failure;

          await this.#record(candidate, outgoing, {
            usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
            latencyMs: Math.round(performance.now() - startedAt),
            attempts,
            succeeded: false,
            errorMessage: failure.message,
            ...recorded,
          });

          // A rejected request fails the same way however often it is sent;
          // only transient failures are worth another attempt or another
          // provider.
          if (!failure.detail.retryable) {
            throw failure;
          }

          this.#remember(candidate, tenantId, failure);

          // A rate-limited key is still rate-limited a second later, so trying
          // the same model again spends a retry to learn nothing. Move on.
          if (failure.kind === 'credential') {
            break;
          }
          // The provider just crossed its threshold; further attempts here
          // would be the very requests the memory exists to stop.
          if (this.#unavailable(candidate, tenantId)) {
            break;
          }
          if (attempt < this.#config.attemptsPerModel) {
            await this.#sleep(BACKOFF_BASE_MS * 2 ** (attempt - 1));
          }
        }
      }
    }

    // What was skipped belongs in the message: "no candidates" would send an
    // operator hunting for a routing bug when the answer is that everything is
    // in cooldown, and until when.
    const because = skipped
      .map((entry) => `${entry.scope} until ${entry.until.toISOString()} (${entry.reason})`)
      .join('; ');
    const detail = lastError?.message ?? (because === '' ? 'no candidates' : `skipped ${because}`);

    throw new ModelGatewayError(
      `every model for task "${outgoing.task}" failed after ${attempts} attempt(s): ${detail}`,
      { provider: 'routed', task: outgoing.task, retryable: true },
      lastError ? { cause: lastError } : {},
    );
  }

  /** Whichever memory is holding this candidate back — the provider's or the key's. */
  #unavailable(candidate: ResolvedCandidate, tenantId: string): Unavailable | null {
    const now = this.#now();
    return (
      this.#availability.blocked(providerScope(candidate.provider), now) ??
      this.#availability.blocked(credentialScope(tenantId, candidate.reference), now)
    );
  }

  /** Charge the failure to whoever it belongs to. */
  #remember(candidate: ResolvedCandidate, tenantId: string, failure: ModelGatewayError): void {
    const scope =
      failure.kind === 'credential'
        ? credentialScope(tenantId, candidate.reference)
        : providerScope(candidate.provider);

    this.#availability.recordFault(scope, {
      kind: failure.kind,
      reason: failure.message,
      now: this.#now(),
      ...(failure.detail.retryAfterMs === undefined
        ? {}
        : { retryAfterMs: failure.detail.retryAfterMs }),
    });
  }

  /**
   * Shrink the outgoing context, or send it untouched.
   *
   * The pipeline's own floor is "no change, never a wrong value"; an engine that
   * throws outright is held to the same floor here. Losing a compression saving
   * is a cost problem, and failing the user's turn over it would be worse.
   */
  #compress(request: ModelRequest): {
    request: ModelRequest;
    compression?: CompressionUsage;
  } {
    if (!this.#compressor) {
      return { request };
    }

    try {
      const { request: compressed, report } = this.#compressor.compress(request);
      // A declared cacheable prefix is excluded from compression (E5.7) but was
      // still sent, so the recorded totals describe the whole request — not
      // just the part engines were allowed to touch, which would read as a
      // larger saving than the call actually made.
      const prefixTokens = report.cachePrefix?.tokens ?? 0;
      return {
        request: compressed,
        compression: {
          beforeTokens: report.beforeTokens + prefixTokens,
          afterTokens: report.afterTokens + prefixTokens,
        },
      };
    } catch (error) {
      console.warn('context compression failed; sending the request uncompressed', {
        task: request.task,
        error: this.#redactor.redact(error instanceof Error ? error.message : String(error)),
      });
      return { request };
    }
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
      'usage' | 'latencyMs' | 'attempts' | 'succeeded' | 'errorMessage' | 'compression'
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
        error: this.#redactor.redact(error instanceof Error ? error.message : String(error)),
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
