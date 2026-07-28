// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Port: count the tokens in a piece of text.
 *
 * Tokens — not characters — are what a model bills, and every family tokenizes
 * differently: there is no single count that is exact for Claude, GPT, Gemini
 * and Llama at once (each keeps its own vocabulary; some publish it, some only
 * expose a `count_tokens` API). So counting is a port, not a hardcoded formula:
 * a product injects the counter it trusts — a provider's own token API, an
 * exact tokenizer — while the harness ships one good provider-neutral default.
 *
 * Compression uses this to report the *real* token saving of each engine rather
 * than a character proxy — measurement, not the fixed ratio a formula assumes.
 */
export interface TokenCounter {
  /** Tokens in `text`. Empty text counts as zero. */
  count(text: string): number;
}
