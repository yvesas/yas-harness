// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The pipeline: run a profile's engines in order, guarded by the sensitivity
 * gate, and report what each one saved.
 *
 * The gate is enforced here, once, around every engine — so an engine author
 * cannot forget it, and a buggy or over-eager engine cannot slip a corrupted
 * value through. An engine whose output would drop or change a protected value
 * is skipped (its result discarded) and recorded as such; the pipeline carries
 * the last safe request forward. That is what makes "compress the context"
 * safe to turn on: the floor is "no change", never "a wrong value".
 */

import type {
  CompressionEngine,
  CompressionResult,
  ContextCompressor,
  EngineReport,
} from './context-compressor.js';
import { renderRequestText } from './request-text.js';
import { RegexSensitivityGuard, type SensitivityGuard } from './sensitivity-gate.js';
import { GptTokenizerCounter } from '../models/gpt-tokenizer-counter.js';
import type { ModelRequest } from '../models/model-gateway.js';
import type { TokenCounter } from '../models/token-counter.js';

export class CompressionPipeline implements ContextCompressor {
  readonly #engines: readonly CompressionEngine[];
  readonly #guard: SensitivityGuard;
  readonly #counter: TokenCounter;

  constructor(
    engines: readonly CompressionEngine[],
    guard: SensitivityGuard = new RegexSensitivityGuard(),
    counter: TokenCounter = new GptTokenizerCounter(),
  ) {
    // Lower priority runs first; a stable order makes a pass reproducible.
    this.#engines = [...engines].sort((a, b) => a.priority - b.priority);
    this.#guard = guard;
    this.#counter = counter;
  }

  compress(request: ModelRequest): CompressionResult {
    // Whether an engine "shrank" the request is still judged on characters — a
    // cheap, exact signal computed on every step. Tokens are the *reported*
    // saving: measured once per step through the counter, never assumed.
    let currentText = renderRequestText(request);
    let current = request;
    let before = currentText.length;
    let beforeTokens = this.#counter.count(currentText);
    const initial = before;
    const initialTokens = beforeTokens;
    const reports: EngineReport[] = [];

    for (const engine of this.#engines) {
      const candidate = engine.compress(current);
      const candidateText = renderRequestText(candidate);
      const after = candidateText.length;

      if (after >= before) {
        // Nothing gained (or somehow larger); keep the current request.
        reports.push({
          engine: engine.name,
          applied: false,
          reason: 'no reduction',
          before,
          after: before,
          beforeTokens,
          afterTokens: beforeTokens,
        });
        continue;
      }
      if (!this.#guard.preservesSensitive(currentText, candidateText)) {
        reports.push({
          engine: engine.name,
          applied: false,
          reason: 'sensitivity gate: a protected value would change',
          before,
          after: before,
          beforeTokens,
          afterTokens: beforeTokens,
        });
        continue;
      }

      const afterTokens = this.#counter.count(candidateText);
      reports.push({
        engine: engine.name,
        applied: true,
        before,
        after,
        beforeTokens,
        afterTokens,
      });
      current = candidate;
      currentText = candidateText;
      before = after;
      beforeTokens = afterTokens;
    }

    return {
      request: current,
      report: {
        engines: reports,
        before: initial,
        after: before,
        beforeTokens: initialTokens,
        afterTokens: beforeTokens,
      },
    };
  }
}
