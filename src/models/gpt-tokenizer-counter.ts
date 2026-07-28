// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A `TokenCounter` backed by `gpt-tokenizer` (o200k_base BPE, the GPT-4o
 * family). It is real BPE tokenization, not a char/word heuristic: exact for
 * OpenAI models and, for English text, a close approximation (within ~5-15%)
 * for Claude, Gemini and Llama — whose exact counts are only available from
 * each provider's own API. Pure-JS and offline, so it can size a request before
 * any provider call is made, which is exactly when compression runs.
 *
 * When an exact per-provider count matters, inject that provider's counter
 * through the `TokenCounter` port instead — this is the sensible default, not
 * the only option.
 */

import { countTokens } from 'gpt-tokenizer';

import type { TokenCounter } from './token-counter.js';

export class GptTokenizerCounter implements TokenCounter {
  count(text: string): number {
    if (text.length === 0) {
      return 0;
    }
    return countTokens(text);
  }
}
