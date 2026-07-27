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
import { renderRequestText, requestSize } from './request-text.js';
import { RegexSensitivityGuard, type SensitivityGuard } from './sensitivity-gate.js';
import type { ModelRequest } from '../models/model-gateway.js';

export class CompressionPipeline implements ContextCompressor {
  readonly #engines: readonly CompressionEngine[];
  readonly #guard: SensitivityGuard;

  constructor(
    engines: readonly CompressionEngine[],
    guard: SensitivityGuard = new RegexSensitivityGuard(),
  ) {
    // Lower priority runs first; a stable order makes a pass reproducible.
    this.#engines = [...engines].sort((a, b) => a.priority - b.priority);
    this.#guard = guard;
  }

  compress(request: ModelRequest): CompressionResult {
    const initial = requestSize(request);
    let current = request;
    const reports: EngineReport[] = [];

    for (const engine of this.#engines) {
      const before = requestSize(current);
      const candidate = engine.compress(current);
      const after = requestSize(candidate);

      if (after >= before) {
        // Nothing gained (or somehow larger); keep the current request.
        reports.push({
          engine: engine.name,
          applied: false,
          reason: 'no reduction',
          before,
          after: before,
        });
        continue;
      }
      if (
        !this.#guard.preservesSensitive(renderRequestText(current), renderRequestText(candidate))
      ) {
        reports.push({
          engine: engine.name,
          applied: false,
          reason: 'sensitivity gate: a protected value would change',
          before,
          after: before,
        });
        continue;
      }

      current = candidate;
      reports.push({ engine: engine.name, applied: true, before, after });
    }

    return {
      request: current,
      report: { engines: reports, before: initial, after: requestSize(current) },
    };
  }
}
