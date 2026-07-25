// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Which model serves which kind of work, and what it costs.
 *
 * This lives in configuration rather than in code because it is the part that
 * changes most: providers release models, prices move, and a product may want
 * a different mix. Changing a route should be a reviewed config edit, not a
 * release.
 */

import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import type { TaskKind } from './model-gateway.js';

/**
 * `cheap` is a cost decision, not a quality judgement: it marks models that
 * sensitive work must never reach.
 */
export const modelTierSchema = z.enum(['cheap', 'premium']);
export type ModelTier = z.infer<typeof modelTierSchema>;

/** Price per million tokens, in USD. */
export const priceSchema = z.object({
  inputPerMTok: z.number().nonnegative(),
  outputPerMTok: z.number().nonnegative(),
  /** Cached input is billed at a fraction of the input rate. */
  cachedInputPerMTok: z.number().nonnegative(),
});

export type Price = z.infer<typeof priceSchema>;

export const modelEntrySchema = z.object({
  /** Must match a registered provider's `name`. */
  provider: z.string().min(1),
  /** The provider's own model id. */
  model: z.string().min(1),
  tier: modelTierSchema,
  price: priceSchema,
});

export type ModelEntry = z.infer<typeof modelEntrySchema>;

const TASK_KINDS = ['routing', 'simple', 'reasoning', 'sensitive'] as const;

export const modelConfigSchema = z.object({
  /** Keyed by an internal reference such as `anthropic/claude-opus-4-8`. */
  models: z.record(z.string().min(1), modelEntrySchema),
  /**
   * Ordered preference per task: the first entry is tried first, the rest are
   * the fallback chain.
   */
  routes: z.object({
    routing: z.array(z.string().min(1)).min(1),
    simple: z.array(z.string().min(1)).min(1),
    reasoning: z.array(z.string().min(1)).min(1),
    sensitive: z.array(z.string().min(1)).min(1),
  }),
  /** How long one provider call may take before it is abandoned. */
  requestTimeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
  /** Retries of the same model on a retryable failure, before falling back. */
  attemptsPerModel: z.number().int().min(1).max(5).default(2),
});

export type ModelConfig = z.infer<typeof modelConfigSchema>;

export class ModelConfigError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'ModelConfigError';
  }
}

/**
 * Parse and check a model configuration.
 *
 * Two rules are enforced here rather than left to review, because both fail
 * silently: a route naming a model that does not exist would only break when
 * that fallback is finally needed, and sensitive work reaching a cheap model
 * would simply produce worse answers, quietly.
 */
export function parseModelConfig(source: unknown, origin: string): ModelConfig {
  const parsed = modelConfigSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new ModelConfigError(`invalid model config in ${origin}: ${detail}`);
  }

  const config = parsed.data;

  for (const task of TASK_KINDS) {
    for (const reference of config.routes[task]) {
      const entry = config.models[reference];
      if (!entry) {
        throw new ModelConfigError(
          `route "${task}" names unknown model "${reference}" in ${origin}`,
        );
      }
      if (task === 'sensitive' && entry.tier === 'cheap') {
        throw new ModelConfigError(
          `route "sensitive" must not use the cheap model "${reference}" in ${origin}: ` +
            'getting a sensitive answer wrong costs more than the tokens saved',
        );
      }
    }
  }

  return config;
}

export async function loadModelConfig(path: string): Promise<ModelConfig> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new ModelConfigError(`cannot read model config from ${path}`, { cause: error });
  }

  let source: unknown;
  try {
    source = JSON.parse(raw);
  } catch (error) {
    throw new ModelConfigError(`model config at ${path} is not valid JSON`, { cause: error });
  }

  return parseModelConfig(source, path);
}

export interface ResolvedCandidate extends ModelEntry {
  /** The configuration key, used in traces and usage records. */
  readonly reference: string;
}

/** The ordered candidates for a task: first choice, then fallbacks. */
export function candidatesFor(config: ModelConfig, task: TaskKind): ResolvedCandidate[] {
  return config.routes[task].map((reference) => ({
    reference,
    // parseModelConfig already proved every reference resolves.
    ...config.models[reference]!,
  }));
}
