// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Cutting a document into pieces small enough to embed and to read.
 *
 * A chunk is what search matches and what a model is handed, so both ends
 * matter: too large and one vector averages away what made the passage
 * relevant; too small and the passage arrives without the sentence that
 * explained it.
 *
 * The split follows the document's own structure rather than a character count
 * — paragraphs first, then sentences, then a hard cut. A boundary the author
 * chose is almost always a better one than a boundary arithmetic chose, and the
 * hard cut exists only for text that has neither.
 *
 * No dependency: this is string handling, and a library would bring a tokenizer
 * whose idea of a token differs from the embedding model's anyway.
 */

export interface ChunkOptions {
  /** Characters per chunk, before overlap. */
  readonly size?: number;
  /**
   * Characters repeated from the end of the previous chunk.
   *
   * Overlap exists so a passage split across a boundary is still findable from
   * either side — without it, the sentence that spans two chunks belongs to
   * neither.
   */
  readonly overlap?: number;
}

const DEFAULTS = { size: 1_200, overlap: 150 } as const;

export function chunk(text: string, options: ChunkOptions = {}): string[] {
  const size = options.size ?? DEFAULTS.size;
  const overlap = Math.min(options.overlap ?? DEFAULTS.overlap, Math.floor(size / 2));

  const normalised = text.replace(/\r\n/g, '\n').trim();
  if (normalised === '') {
    return [];
  }
  if (normalised.length <= size) {
    return [normalised];
  }

  const chunks: string[] = [];
  let current = '';

  for (const piece of split(normalised, size)) {
    if (current === '') {
      current = piece;
      continue;
    }
    if (current.length + piece.length + 2 <= size) {
      current = `${current}\n\n${piece}`;
      continue;
    }
    chunks.push(current);
    // Carry the tail forward, cut at a space so a word is not halved.
    current = overlap > 0 ? `${tail(current, overlap)}\n\n${piece}` : piece;
  }
  if (current !== '') {
    chunks.push(current);
  }

  return chunks;
}

/** Paragraphs, then sentences, then a hard cut — in that order of preference. */
function split(text: string, size: number): string[] {
  const pieces: string[] = [];

  for (const paragraph of text
    .split(/\n{2,}/)
    .map((entry) => entry.trim())
    .filter(Boolean)) {
    if (paragraph.length <= size) {
      pieces.push(paragraph);
      continue;
    }
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
      if (sentence.length <= size) {
        pieces.push(sentence);
        continue;
      }
      // Neither paragraphs nor sentences: a wall of text, a minified file, a
      // language this regex does not punctuate. Cut it rather than refuse it.
      for (let start = 0; start < sentence.length; start += size) {
        pieces.push(sentence.slice(start, start + size));
      }
    }
  }

  return pieces;
}

function tail(text: string, length: number): string {
  const slice = text.slice(-length);
  const space = slice.indexOf(' ');
  return space === -1 ? slice : slice.slice(space + 1);
}
