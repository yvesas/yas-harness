// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Port: turning text into a vector.
 *
 * Separate from `ModelGateway` on purpose, even though the same vendors sell
 * both. A completion is a conversation with a cost per turn and a fallback
 * chain; an embedding is a pure function of a string that has to stay stable
 * for the life of a corpus. Routing an embedding to a fallback provider would
 * silently make yesterday's vectors uncomparable with today's — the one failure
 * this port exists to prevent.
 *
 * **The dimension is part of the schema, not configuration.** `memory_chunks`
 * declares `vector(1536)`, so a deployment whose model produces something else
 * changes that migration in its fork. It could not be a setting: the column
 * type is fixed when the table is created, and a mismatch discovered at query
 * time is a corpus half-embedded with two incompatible models.
 */

/**
 * What a deployment gets if it declares nothing.
 *
 * A default, not a law: the number belongs to the model somebody chose, and
 * vendors disagree — 1536 at OpenAI, 1024 at Voyage, Cohere and Mistral, 768
 * for a local nomic. It is declared in `config/models.json` and reaches the
 * `vector(N)` column when the migration runs.
 */
export const DEFAULT_EMBEDDING_DIMENSIONS = 1536;

/**
 * Why a text is being embedded.
 *
 * A question and the passage that answers it are not written alike — one is
 * short and interrogative, the other long and declarative — so several vendors
 * embed them into deliberately different shapes and ask you to say which you
 * have. Measured on this repository's own corpus with Voyage: the same pair
 * sat at cosine 0.628 without the distinction and 0.399 with it, which is the
 * difference between a passage found and a passage missed under a 0.6 ceiling.
 *
 * The store has always known which it was doing — `ingest` embeds documents,
 * `search` embeds a question — and used to throw the fact away.
 */
export type EmbeddingPurpose = 'document' | 'query';

export interface Embedder {
  /** The model's name, recorded so a corpus can say what embedded it. */
  readonly model: string;
  /** What this model returns per passage, and what the column must hold. */
  readonly dimensions: number;
  /**
   * Embed a batch, in order. The result is parallel to the input — a caller
   * pairs them by index, so an adapter must never drop or reorder.
   *
   * An adapter whose provider does not distinguish the two purposes ignores
   * the second argument, and nothing is lost by saying it.
   */
  embed(texts: readonly string[], purpose: EmbeddingPurpose): Promise<number[][]>;
}

/**
 * Port: which embedder to use for a given tenant.
 *
 * The layer that exists because a key is not the deployment's to own. A tenant
 * that pasted their own embedding key into the console has their documents
 * embedded on their account; one that pasted none uses the platform's, if the
 * deployment configured one at all. `Embedder` stays what it says it is — text
 * in, vectors out — and the question of *whose* key is asked here.
 *
 * Asked on every ingest and every search rather than resolved once and cached,
 * for the same reason the credential vault unseals per call: a key revoked a
 * minute ago should not still be in use, and a decrypted key held in a field is
 * a decrypted key in a heap dump.
 */
export interface EmbedderFactory {
  for(tenantId: string): Promise<Embedder>;
}

/**
 * One embedder for everybody — the deployment's own.
 *
 * For tests, and for a product that has no per-tenant keys and does not want
 * the machinery.
 */
export function fixedEmbedder(embedder: Embedder): EmbedderFactory {
  return { for: () => Promise.resolve(embedder) };
}

export class EmbeddingError extends Error {
  constructor(
    message: string,
    readonly detail: { readonly model: string; readonly retryable: boolean },
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'EmbeddingError';
  }
}

/**
 * Check what an adapter returned before it reaches the database.
 *
 * The database would reject a wrong-sized vector anyway, and the message would
 * be about a column. This one is about the model, which is the thing that has
 * to change.
 */
export function assertDimensions(
  model: string,
  vectors: readonly number[][],
  expected: number,
): void {
  for (const vector of vectors) {
    if (vector.length !== expected) {
      throw new EmbeddingError(
        `"${model}" produced ${String(vector.length)} dimensions; this deployment stores ` +
          `${String(expected)}. Set "dimensions": ${String(vector.length)} in the embedding block ` +
          `of config/models.json and migrate again — which re-creates the column, so anything ` +
          `already indexed has to be indexed again. Vectors from two models are not comparable.`,
        { model, retryable: false },
      );
    }
  }
}
