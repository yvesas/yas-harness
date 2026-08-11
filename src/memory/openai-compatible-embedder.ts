// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: any `/embeddings` endpoint speaking the OpenAI shape.
 *
 * The same convergence the completion adapter relies on: OpenAI, Together,
 * Fireworks, Voyage, Mistral, a local Ollama or vLLM all answer this. So a
 * vendor is a base URL and a model name, and no file in this folder names one.
 *
 * Written against `fetch`, like everything else here.
 */

import { trimTrailingSlashes } from '../http/base-url.js';

import { assertDimensions, EmbeddingError, type Embedder } from './embedder.js';

export interface OpenAiCompatibleEmbedderOptions {
  readonly model: string;
  readonly baseUrl: string;
  /** What this model returns per passage; checked before anything is stored. */
  readonly dimensions: number;
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
  /** Texts per request. Providers cap this; 64 is under every cap in reach. */
  readonly batchSize?: number;
  readonly fetch?: typeof globalThis.fetch;
}

const DEFAULT_BATCH = 64;
const RETRYABLE = new Set([408, 429, 500, 502, 503, 504]);

interface EmbeddingResponse {
  data?: { index?: number; embedding?: number[] }[];
}

export class OpenAiCompatibleEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  readonly #baseUrl: string;
  readonly #apiKey: string;
  readonly #batch: number;
  readonly #fetch: typeof globalThis.fetch;

  constructor(options: OpenAiCompatibleEmbedderOptions) {
    this.model = options.model;
    this.dimensions = options.dimensions;
    this.#baseUrl = trimTrailingSlashes(options.baseUrl);
    const key = options.apiKey ?? (options.apiKeyEnv ? process.env[options.apiKeyEnv] : undefined);
    if (!key) {
      throw new EmbeddingError(
        `${options.apiKeyEnv ?? `the API key for "${options.model}"`} is not set`,
        { model: options.model, retryable: false },
      );
    }
    this.#apiKey = key;
    this.#batch = options.batchSize ?? DEFAULT_BATCH;
    this.#fetch = options.fetch ?? globalThis.fetch;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += this.#batch) {
      vectors.push(...(await this.#batchEmbed(texts.slice(start, start + this.#batch))));
    }
    assertDimensions(this.model, vectors, this.dimensions);
    return vectors;
  }

  async #batchEmbed(batch: readonly string[]): Promise<number[][]> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}/embeddings`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.#apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ model: this.model, input: batch }),
      });
    } catch (error) {
      throw new EmbeddingError(
        `embedding request failed: ${error instanceof Error ? error.message : String(error)}`,
        { model: this.model, retryable: true },
        { cause: error },
      );
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new EmbeddingError(
        `embedding endpoint answered ${String(response.status)}: ${body.slice(0, 300)}`,
        { model: this.model, retryable: RETRYABLE.has(response.status) },
      );
    }

    const payload = (await response.json()) as EmbeddingResponse;
    const data = payload.data ?? [];
    if (data.length !== batch.length) {
      // Pairing is by position, so a short answer would silently attach the
      // wrong vector to the rest of the batch.
      throw new EmbeddingError(
        `asked for ${String(batch.length)} embeddings and got ${String(data.length)}`,
        { model: this.model, retryable: false },
      );
    }

    // Providers may answer out of order but always say which index each is.
    const ordered: number[][] = new Array<number[]>(batch.length);
    for (const [position, entry] of data.entries()) {
      const index = entry.index ?? position;
      if (!entry.embedding) {
        throw new EmbeddingError(`embedding ${String(index)} came back empty`, {
          model: this.model,
          retryable: false,
        });
      }
      ordered[index] = entry.embedding;
    }
    return ordered;
  }
}
