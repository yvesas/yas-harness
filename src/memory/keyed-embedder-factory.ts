// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The embedder for a tenant: their own key when they brought one.
 *
 * Shared knowledge was the last thing that could only be paid for with an
 * environment variable. That made it the one part of the product where the
 * person running the harness had to hold a key on everybody's behalf — which
 * is exactly what a project meant to be forked should not require.
 *
 * The rule is simpler than the completion side's, and deliberately so. There
 * is one embedding provider, so there is no routing decision to protect: a
 * tenant with a key uses it, a tenant without uses the platform's if the
 * deployment configured one, and a deployment that configured none says so at
 * the moment something tries to embed.
 *
 * It does **not** inherit "bringing a key opts out of the platform's" from
 * `ModelKeys`. That rule exists to stop a tenant's data reaching a provider
 * they did not choose; here there is only ever one provider and one endpoint,
 * so there is nothing to be routed away to.
 *
 * **The model must not change under an existing corpus.** Vectors embedded by
 * two different models are not comparable, so a tenant's key changes *who
 * pays*, never *what embeds* — the model name and base URL come from
 * `config/models.json` for everybody.
 */

import type { ModelKeys } from '../models/model-keys.js';
import type { EmbeddingProvider } from '../models/routing.js';

import { EmbeddingError, type Embedder, type EmbedderFactory } from './embedder.js';
import { OpenAiCompatibleEmbedder } from './openai-compatible-embedder.js';

export interface KeyedEmbedderOptions {
  readonly entry: EmbeddingProvider;
  /** Where a tenant's own key is read from. Absent means platform key only. */
  readonly modelKeys?: ModelKeys;
  readonly fetch?: typeof globalThis.fetch;
}

export class KeyedEmbedderFactory implements EmbedderFactory {
  readonly #entry: EmbeddingProvider;
  readonly #modelKeys: ModelKeys | undefined;
  readonly #fetch: typeof globalThis.fetch | undefined;

  constructor(options: KeyedEmbedderOptions) {
    this.#entry = options.entry;
    this.#modelKeys = options.modelKeys;
    this.#fetch = options.fetch;
  }

  async for(tenantId: string): Promise<Embedder> {
    const own = await this.#own(tenantId);

    // The environment is checked here rather than left to the adapter, which
    // would name only the variable. That was the right message when a variable
    // was the only way; now it is the fallback, and a message that mentions
    // just it sends somebody to edit a file when the answer is a form.
    const platform = this.#entry.apiKeyEnv ? (process.env[this.#entry.apiKeyEnv] ?? '') : '';

    if (own === null && platform === '') {
      throw new EmbeddingError(
        `nothing can be embedded: this tenant has no embedding key, and ` +
          (this.#entry.apiKeyEnv === undefined
            ? `this deployment declared no environment variable for one. Paste a key on the ` +
              `Keys page in the console.`
            : `${this.#entry.apiKeyEnv} is not set either. Paste a key on the Keys page in the ` +
              `console -- that is the supported way, and it is encrypted at rest -- or set that ` +
              `variable for the whole deployment.`),
        { model: this.#entry.model, retryable: false },
      );
    }

    return new OpenAiCompatibleEmbedder({
      model: this.#entry.model,
      baseUrl: this.#entry.baseUrl,
      dimensions: this.#entry.dimensions,
      inputType: this.#entry.inputType,
      // Passed as a value either way: which one it is has already been decided
      // above, and handing the adapter a variable name to read again would put
      // the decision in two places.
      apiKey: own ?? platform,
      ...(this.#fetch ? { fetch: this.#fetch } : {}),
    });
  }

  async #own(tenantId: string): Promise<string | null> {
    if (!this.#modelKeys) {
      return null;
    }
    try {
      return await this.#modelKeys.resolve(tenantId, this.#entry.provider);
    } catch (error) {
      // Not swallowed into "they have none": that would quietly embed their
      // documents on the platform's account, which is the thing bringing a key
      // was meant to prevent.
      throw new EmbeddingError(
        `could not unseal the embedding key for tenant "${tenantId}"`,
        { model: this.#entry.model, retryable: true },
        { cause: error },
      );
    }
  }
}
