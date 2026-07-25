// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Router evaluation.
 *
 * The cheap router is only worth trusting once its hit rate is measured, so
 * the harness ships the way to measure it: a versioned set of cases and a
 * runner that reports accuracy. Products add their own cases against their own
 * modules; this file is the mechanism, not the data.
 */

import { z } from 'zod';

import type { Router } from './router.js';

export const routerCaseSchema = z.object({
  /** What the user said. */
  input: z.string().min(1),
  /** The module id this input should route to. */
  expected: z.string().min(1),
  /** Optional note on why, for whoever reads a failure. */
  note: z.string().optional(),
});

export type RouterCase = z.infer<typeof routerCaseSchema>;

export const routerCaseSetSchema = z.array(routerCaseSchema).min(1);

export interface CaseOutcome {
  readonly input: string;
  readonly expected: string;
  /** The module chosen, or null if the router failed to decide. */
  readonly actual: string | null;
  readonly correct: boolean;
  readonly confidence: number | null;
  /** Present when the router threw rather than deciding. */
  readonly error?: string;
}

export interface EvalReport {
  readonly total: number;
  readonly correct: number;
  /** correct / total, 0..1. */
  readonly accuracy: number;
  readonly outcomes: readonly CaseOutcome[];
}

/**
 * Run every case through the router and report how many it got right.
 *
 * A router that throws on a case counts as wrong, not as a crash: a case set
 * is meant to find exactly that, and one bad case should not stop the run.
 */
export async function evaluateRouter(
  router: Router,
  cases: readonly RouterCase[],
): Promise<EvalReport> {
  const outcomes: CaseOutcome[] = [];

  for (const testCase of cases) {
    try {
      const decision = await router.route({ text: testCase.input });
      outcomes.push({
        input: testCase.input,
        expected: testCase.expected,
        actual: decision.moduleId,
        correct: decision.moduleId === testCase.expected,
        confidence: decision.confidence,
      });
    } catch (error) {
      outcomes.push({
        input: testCase.input,
        expected: testCase.expected,
        actual: null,
        correct: false,
        confidence: null,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const correct = outcomes.filter((outcome) => outcome.correct).length;
  return {
    total: outcomes.length,
    correct,
    accuracy: outcomes.length === 0 ? 0 : correct / outcomes.length,
    outcomes,
  };
}

/** The cases the router got wrong, for a readable failure summary. */
export function failures(report: EvalReport): CaseOutcome[] {
  return report.outcomes.filter((outcome) => !outcome.correct);
}
