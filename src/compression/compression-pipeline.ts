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
 *
 * A request that declares a cacheable prefix gets a second guarantee (E5.7):
 * that prefix is split off before any engine runs and spliced back byte-for-
 * byte after, so the bytes a provider matches its cache on never move.
 */

import type {
  CachePrefixReport,
  CompressionEngine,
  CompressionResult,
  ContextCompressor,
  EngineReport,
} from './context-compressor.js';
import { renderRequestText } from './request-text.js';
import { RegexSensitivityGuard, type SensitivityGuard } from './sensitivity-gate.js';
import { GptTokenizerCounter } from '../models/gpt-tokenizer-counter.js';
import { cachePrefixLength, type ModelRequest } from '../models/model-gateway.js';
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
    const prefixLength = cachePrefixLength(request);
    if (prefixLength === undefined) {
      return this.#run(request);
    }

    // A declared cacheable prefix is off limits. Provider caches match on exact
    // leading bytes, and *lossless* is not the same as byte-identical: even the
    // whitespace engine would rewrite the prefix and lose the match. What that
    // costs is asymmetric — a cached read bills a fraction of the input rate,
    // while re-writing the entry bills above it — so the saving from squeezing
    // an already-discounted prefix cannot pay for the misses it causes. Splitting
    // it off, rather than restoring it afterwards, also keeps the report honest:
    // an engine can no longer look like it shrank the request by editing bytes
    // that get put back.
    const head = request.messages.slice(0, prefixLength);
    const compressed = this.#run(this.#compressibleRegion(request, prefixLength));

    return {
      request: { ...request, messages: [...head, ...compressed.request.messages] },
      report: { ...compressed.report, cachePrefix: this.#measure(request, prefixLength) },
    };
  }

  /**
   * The part of a request engines may touch: everything after the prefix, with
   * `system` and `tools` dropped because both render *inside* the cached region.
   */
  #compressibleRegion(request: ModelRequest, prefixLength: number): ModelRequest {
    const { system: _system, tools: _tools, cachePrefix: _cachePrefix, ...carried } = request;
    return { ...carried, messages: request.messages.slice(prefixLength) };
  }

  /** What the untouched prefix costs, so a reader can still see the whole request. */
  #measure(request: ModelRequest, prefixLength: number): CachePrefixReport {
    const text = renderRequestText({
      ...request,
      messages: request.messages.slice(0, prefixLength),
    });
    return { chars: text.length, tokens: this.#counter.count(text) };
  }

  #run(request: ModelRequest): CompressionResult {
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
      // A lossless engine must keep every protected value; a lossy one may drop
      // content but must never invent or mangle one. Either way, the gate never
      // lets a value come out *wrong*.
      const safe = engine.lossy
        ? this.#guard.introducesNoSensitive(currentText, candidateText)
        : this.#guard.preservesSensitive(currentText, candidateText);
      if (!safe) {
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
