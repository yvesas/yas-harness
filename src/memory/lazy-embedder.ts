// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * An embedder that is not built until something embeds.
 *
 * The same mistake as the model providers, made twice: an embedder reads its
 * key in its constructor, so building it while the harness is built meant a
 * deployment that had declared an embedding provider without setting its key
 * could not start at all — not even to list what it already knows.
 *
 * Everything that does not embed keeps working: browsing sources, reading a
 * document, deleting one. Only search and ingest need the key, and that is
 * where the error now appears, saying the same thing it always said.
 */

import type { Embedder, EmbeddingPurpose } from './embedder.js';

export class LazyEmbedder implements Embedder {
  readonly model: string;
  readonly dimensions: number;
  readonly #build: () => Embedder;
  #embedder: Embedder | null = null;

  constructor(model: string, dimensions: number, build: () => Embedder) {
    this.model = model;
    this.dimensions = dimensions;
    this.#build = build;
  }

  embed(texts: readonly string[], purpose: EmbeddingPurpose): Promise<number[][]> {
    // Built once and kept: an embedder holds a client, and rebuilding it per
    // batch would throw away whatever connection reuse it manages.
    this.#embedder ??= this.#build();
    return this.#embedder.embed(texts, purpose);
  }

  /** True once something has actually embedded. For tests. */
  get built(): boolean {
    return this.#embedder !== null;
  }
}
