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

/** What every chunk in the corpus must agree on. */
export const EMBEDDING_DIMENSIONS = 1536;

export interface Embedder {
  /** The model's name, recorded so a corpus can say what embedded it. */
  readonly model: string;
  /**
   * Embed a batch, in order. The result is parallel to the input — a caller
   * pairs them by index, so an adapter must never drop or reorder.
   */
  embed(texts: readonly string[]): Promise<number[][]>;
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
export function assertDimensions(model: string, vectors: readonly number[][]): void {
  for (const vector of vectors) {
    if (vector.length !== EMBEDDING_DIMENSIONS) {
      throw new EmbeddingError(
        `"${model}" produced ${String(vector.length)} dimensions; this schema stores ${String(
          EMBEDDING_DIMENSIONS,
        )}. Either use a model of that size, or change the vector column in migration 0012 and re-embed everything.`,
        { model, retryable: false },
      );
    }
  }
}
