// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Compression evaluation: does a smaller prompt still get the right answer?
 *
 * The sensitivity gate proves a value was not *corrupted*, which is a property
 * of the text. It cannot prove the model still *used* it. That needs the model,
 * so this runner asks each case twice — once uncompressed, once compressed —
 * and reports the only outcome that should block a release: a case the baseline
 * got right and the compressed run got wrong. Savings are reported alongside,
 * because a release decision is the trade between the two.
 *
 * A case that fails both ways is not compression's fault and is counted apart:
 * it says the prompt or the model is wrong, and folding it into the regression
 * count would let a broken case set quietly veto a good engine.
 *
 * Write cases whose `expect` values are facts a correct answer must carry — an
 * id, a total, a date — never phrasing. Models vary between runs; an assertion
 * on wording turns that variance into a regression that isn't one.
 *
 * Like the router's eval (`src/router/eval.ts`) this is the mechanism, not the
 * data: products keep their own versioned cases against their own prompts.
 */

import { z } from 'zod';

import type { ContextCompressor } from './context-compressor.js';
import type {
  ModelGateway,
  ModelMessage,
  ModelRequest,
  TaskKind,
} from '../models/model-gateway.js';
import { responseText, userMessage } from '../models/model-gateway.js';

export const compressionCaseSchema = z.object({
  /** What the user asked. */
  input: z.string().min(1),
  /**
   * The bulk context the engines actually work on — command output, dumps,
   * fetched documents — delivered as tool results, which is how it reaches a
   * real conversation and the only shape the lossy engine touches.
   */
  toolResults: z
    .array(
      z.object({
        content: z.string().min(1),
        isError: z.boolean().optional(),
      }),
    )
    .optional(),
  /** Values a correct answer must still contain, byte for byte. */
  expect: z.array(z.string().min(1)).min(1),
  /** Optional note on why, for whoever reads a regression. */
  note: z.string().optional(),
});

export type CompressionCase = z.infer<typeof compressionCaseSchema>;

export const compressionCaseSetSchema = z.array(compressionCaseSchema).min(1);

export interface CompressionCaseOutcome {
  readonly input: string;
  /** Whether the uncompressed run answered with every expected value. */
  readonly baselinePassed: boolean;
  readonly compressedPassed: boolean;
  /** The gate: compression turned a right answer into a wrong one. */
  readonly regressed: boolean;
  /** Expected values missing from the compressed answer. */
  readonly missing: readonly string[];
  readonly beforeTokens: number;
  readonly afterTokens: number;
  /** Present when a call threw rather than answering. */
  readonly error?: string;
}

export interface CompressionEvalReport {
  readonly total: number;
  /** Cases the baseline got right and compression broke. Zero is the gate. */
  readonly regressions: number;
  /** Cases neither run got right — a problem with the case, not the engines. */
  readonly inconclusive: number;
  readonly beforeTokens: number;
  readonly afterTokens: number;
  /** Share of measured tokens compression removed, 0..1. */
  readonly savedRatio: number;
  readonly outcomes: readonly CompressionCaseOutcome[];
}

/**
 * Build the request a case describes: the question, then the bulk context as a
 * tool call and its result — the shape context genuinely arrives in.
 */
export function toModelRequest(
  testCase: CompressionCase,
  task: TaskKind = 'reasoning',
): ModelRequest {
  const results = testCase.toolResults ?? [];
  if (results.length === 0) {
    return { task, messages: [userMessage(testCase.input)] };
  }

  const asked: ModelMessage = {
    role: 'assistant',
    content: results.map((_, index) => ({
      type: 'tool_call',
      id: `eval-${index}`,
      name: 'context',
      input: {},
    })),
  };
  const answered: ModelMessage = {
    role: 'user',
    content: results.map((result, index) => ({
      type: 'tool_result',
      toolCallId: `eval-${index}`,
      content: result.content,
      isError: result.isError ?? false,
    })),
  };

  return { task, messages: [userMessage(testCase.input), asked, answered] };
}

/**
 * Run every case uncompressed and compressed, and report what changed.
 *
 * A case that throws is recorded, not rethrown: a case set exists to find bad
 * cases, and one of them should not end the run. A throw on the compressed side
 * alone still counts as a regression — a request the provider rejects is a way
 * compression can break an answer.
 */
export async function evaluateCompression(
  gateway: ModelGateway,
  compressor: ContextCompressor,
  cases: readonly CompressionCase[],
  task: TaskKind = 'reasoning',
): Promise<CompressionEvalReport> {
  const outcomes: CompressionCaseOutcome[] = [];

  for (const testCase of cases) {
    const request = toModelRequest(testCase, task);
    const { request: compressedRequest, report } = compressor.compress(request);
    // The cacheable prefix is excluded from compression (E5.7) but was still
    // sent; counting it keeps the ratio a share of the whole request.
    const prefixTokens = report.cachePrefix?.tokens ?? 0;

    const baseline = await answer(gateway, request);
    const compressed = await answer(gateway, compressedRequest);

    const baselinePassed =
      baseline.text !== null && missingFrom(baseline.text, testCase.expect).length === 0;
    const missing =
      compressed.text === null ? testCase.expect : missingFrom(compressed.text, testCase.expect);
    const compressedPassed = compressed.text !== null && missing.length === 0;
    const error = compressed.error ?? baseline.error;

    outcomes.push({
      input: testCase.input,
      baselinePassed,
      compressedPassed,
      regressed: baselinePassed && !compressedPassed,
      missing,
      beforeTokens: report.beforeTokens + prefixTokens,
      afterTokens: report.afterTokens + prefixTokens,
      ...(error === undefined ? {} : { error }),
    });
  }

  const beforeTokens = sum(outcomes.map((outcome) => outcome.beforeTokens));
  const afterTokens = sum(outcomes.map((outcome) => outcome.afterTokens));

  return {
    total: outcomes.length,
    regressions: outcomes.filter((outcome) => outcome.regressed).length,
    inconclusive: outcomes.filter((outcome) => !outcome.baselinePassed).length,
    beforeTokens,
    afterTokens,
    savedRatio: beforeTokens === 0 ? 0 : (beforeTokens - afterTokens) / beforeTokens,
    outcomes,
  };
}

/** The cases compression broke, for a readable failure summary. */
export function regressions(report: CompressionEvalReport): CompressionCaseOutcome[] {
  return report.outcomes.filter((outcome) => outcome.regressed);
}

/**
 * The release gate: a compression profile may go into the data path only when it
 * breaks nothing the model was getting right. Savings never buy a regression —
 * a wrong answer costs more than the tokens it saved.
 */
export function passesGate(report: CompressionEvalReport): boolean {
  return report.regressions === 0;
}

async function answer(
  gateway: ModelGateway,
  request: ModelRequest,
): Promise<{ text: string | null; error?: string }> {
  try {
    return { text: responseText(await gateway.complete(request)) };
  } catch (error) {
    return { text: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function missingFrom(text: string, expected: readonly string[]): string[] {
  return expected.filter((value) => !text.includes(value));
}

function sum(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0);
}
