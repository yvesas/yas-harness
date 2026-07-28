// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Compression profiles: a named subset of engines.
 *
 * A profile is how a product dials the aggressiveness. The line that matters is
 * lossless vs lossy: `light` and `medium` only rewrite (whitespace, then the
 * JSON-table engine), so they never drop anything; `aggressive` adds the
 * tool-result engine, which truncates and deduplicates — real dropping, under
 * the pipeline's lossy gate. `none` is the identity: it exists so a product can
 * wire the pipeline and keep it off, the default posture until compression is
 * eval-gated.
 */

import { CompressionPipeline } from './compression-pipeline.js';
import type { CompressionEngine, ContextCompressor } from './context-compressor.js';
import { RegexSensitivityGuard, type SensitivityGuard } from './sensitivity-gate.js';
import { JsonTableEngine } from './engines/json-table-engine.js';
import { ToolResultEngine } from './engines/tool-result-engine.js';
import { WhitespaceEngine } from './engines/whitespace-engine.js';
import type { TokenCounter } from '../models/token-counter.js';

export type CompressionProfile = 'none' | 'light' | 'medium' | 'aggressive';

/** The engines each profile enables, built fresh so configs are independent. */
const PROFILES: Record<CompressionProfile, () => CompressionEngine[]> = {
  none: () => [],
  light: () => [new WhitespaceEngine()],
  medium: () => [new WhitespaceEngine(), new JsonTableEngine()],
  aggressive: () => [new WhitespaceEngine(), new JsonTableEngine(), new ToolResultEngine()],
};

/**
 * Build a compressor for a profile. Unknown profiles fall back to `none`.
 *
 * `counter` is how a product swaps the default token counter for an exact,
 * per-provider one; omit it to use the pipeline's provider-neutral default.
 */
export function compressorFor(
  profile: CompressionProfile,
  guard: SensitivityGuard = new RegexSensitivityGuard(),
  counter?: TokenCounter,
): ContextCompressor {
  const engines = (PROFILES[profile] ?? PROFILES.none)();
  return counter
    ? new CompressionPipeline(engines, guard, counter)
    : new CompressionPipeline(engines, guard);
}
