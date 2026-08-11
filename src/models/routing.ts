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

/**
 * How to reach one provider.
 *
 * Declared in configuration rather than known by the harness. A chassis that
 * hardcodes a list of vendors has chosen them for every product built on it,
 * and the whole point of the `ModelProvider` port is that it has not.
 */
/**
 * The **name of an environment variable**, not a key.
 *
 * Uppercase is demanded rather than merely conventional, and the reason is a
 * mistake somebody actually made: a provider key pasted into this field on the
 * console's config screen. A key is a run of letters, digits and underscores,
 * so no shape rule about "identifier-ness" would have caught it -- but every
 * provider key in circulation has lowercase in it, and no environment variable
 * anybody names does.
 *
 * The cost of being strict is a deployment with lowercase variable names, which
 * is legal and vanishingly rare, and which gets an error saying exactly what to
 * do. The cost of being loose is a secret in a file that is read back and
 * displayed.
 */
const environmentVariableName = z
  .string()
  .min(1)
  .max(64)
  .regex(
    /^[A-Z][A-Z0-9_]*$/,
    'must be the NAME of an environment variable (upper case, like MY_MODEL_KEY) -- ' +
      "not the key itself. Paste the key on the console's Keys page, where it is encrypted",
  );

export const providerEntrySchema = z.object({
  /**
   * Which adapter speaks to it.
   *
   * `openai-compatible` covers most of the market — Groq, Together, Fireworks,
   * Cerebras, Mistral, xAI, OpenRouter, OpenAI itself, a local vLLM or Ollama,
   * and Gemini's compatible endpoint. `anthropic` is separate because the
   * harness uses features its native API has and the compatible shape does not.
   */
  kind: z.enum(['openai-compatible', 'anthropic']),
  /** Where the API lives. Required for `openai-compatible`; optional otherwise. */
  baseUrl: z.string().url().optional(),
  /**
   * The environment variable holding the key.
   *
   * Named here so no vendor's convention is written into the harness, and so
   * two deployments of the same provider can use different variables.
   */
  apiKeyEnv: environmentVariableName,
});

export type ProviderEntry = z.infer<typeof providerEntrySchema>;

export const modelEntrySchema = z.object({
  /** Must match a registered provider's `name`. */
  provider: z.string().min(1),
  /** The provider's own model id. */
  model: z.string().min(1),
  tier: modelTierSchema,
  price: priceSchema,
  /**
   * The most this model may be asked to write, when the harness's own default
   * is wrong for it.
   *
   * A property of the model **and of the account**, which is why it lives here
   * rather than in an adapter. Providers count the ceiling you ask for against
   * a per-minute budget *before* reading a word of the prompt, so a default
   * that is generous for one model rejects every request to another: a
   * free-tier 8B with a 6000-token minute refuses an 8000-token ceiling
   * outright, whatever you actually asked it.
   *
   * Worth describing because the failure does not look like a limit. It
   * arrives as a 413 on the very first call, with any prompt, and reads as
   * though the message was too big.
   */
  maxOutputTokens: z.number().int().min(1).max(200_000).optional(),
});

export type ModelEntry = z.infer<typeof modelEntrySchema>;

const TASK_KINDS = ['routing', 'simple', 'reasoning', 'sensitive'] as const;

/**
 * Where embeddings come from, when this deployment wants shared knowledge.
 *
 * Beside the completion providers and shaped like them, for the same reason: a
 * vendor is configuration. Optional — a deployment with no embedding provider
 * has no supermemory, and says so rather than half-working.
 */
export const embeddingProviderSchema = z.object({
  /** The embedding model's own name, e.g. `text-embedding-3-small`. */
  model: z.string().min(1),
  /** Where `/embeddings` lives. */
  baseUrl: z.string().url(),
  /**
   * The name a tenant's own embedding key is filed under.
   *
   * It exists so shared knowledge can be paid for the same way completions are
   * — a key pasted into the console rather than an environment variable the
   * person running this does not control. Distinct from the completion
   * providers on purpose, and checked below: a name shared with one of them
   * would make an embedding key look like a completion key to the router.
   */
  provider: z.string().min(1).default('embedding'),
  /**
   * How many numbers this model returns per passage.
   *
   * Configuration rather than a constant, because it is a property of the model
   * somebody chose and every vendor picks differently — 1536 at OpenAI, 1024 at
   * Voyage, Cohere and Mistral, 768 for a local nomic. Hard-coding one would
   * make the schema pick the vendor, which is the one thing this file exists to
   * avoid.
   *
   * It reaches the database: `memory_chunks.embedding` is declared `vector(N)`
   * with this N, substituted when the migration runs. **Changing it after
   * anything is indexed means re-embedding the corpus** — vectors from two
   * models are not comparable, so there is nothing to convert.
   */
  dimensions: z.number().int().min(1).max(16_000).default(1536),
  /**
   * The environment variable holding the platform's key, when there is one.
   *
   * Optional, and that is the point: a deployment where every tenant brings
   * their own has no platform key to name, and requiring one would put a
   * secret in the environment purely to satisfy a schema.
   */
  apiKeyEnv: environmentVariableName.optional(),
});

export type EmbeddingProvider = z.infer<typeof embeddingProviderSchema>;

export const modelConfigSchema = z.object({
  /**
   * Which providers this deployment can reach, keyed by the name its models
   * refer to. Required: the harness builds providers from this and knows no
   * vendor of its own.
   */
  providers: z.record(z.string().min(1), providerEntrySchema),
  /** Keyed by an internal reference such as `premium/opus`. */
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
  /** Where embeddings come from. Absent means no shared knowledge. */
  embedding: embeddingProviderSchema.optional(),
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

  // A model naming a provider nobody declared is a wiring mistake that would
  // otherwise surface the first time that model is routed to — which, for a
  // fallback, can be weeks later and in production.
  for (const [reference, entry] of Object.entries(config.models)) {
    const provider = config.providers[entry.provider];
    if (!provider) {
      throw new ModelConfigError(
        `model "${reference}" names undeclared provider "${entry.provider}" in ${origin}: ` +
          `add it under "providers" with its kind, base URL and key variable`,
      );
    }
    if (provider.kind === 'openai-compatible' && provider.baseUrl === undefined) {
      throw new ModelConfigError(
        `provider "${entry.provider}" is openai-compatible and needs a baseUrl in ${origin}`,
      );
    }
  }

  // The embedding key is filed under its own name and must stay that way. A
  // name shared with a completion provider would make an embedding key look to
  // the router like a key for that provider — so a tenant who paid only for
  // embeddings would have their turns routed as if they had brought a
  // completion key, and every uncovered task would fail.
  if (config.embedding && config.providers[config.embedding.provider]) {
    throw new ModelConfigError(
      `the embedding provider is called "${config.embedding.provider}" in ${origin}, which is ` +
        `also a completion provider. Give it a name of its own — its key is a different key`,
    );
  }

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
    // Names the fix, because the most likely reason is a fresh clone: this
    // file is a deployment's own and is not in Git, so it has to be created
    // once. `start.sh` does it; anybody bypassing that gets told how.
    throw new ModelConfigError(
      `cannot read model config from ${path}. It is not in Git -- which vendor answers is ` +
        `yours to choose -- so copy the example next to it: ` +
        `cp config/models.example.json config/models.json`,
      { cause: error },
    );
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
