// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

'use server';

/**
 * Running the router eval from a page.
 *
 * The eval framework already existed and was reachable only from a script.
 * That is enough for CI and not enough for the loop the console is for:
 * change a route in `config/models.json`, run the cases, see whether the cheap
 * tier still gets them right, adjust. A number nobody looks at is a number that
 * stops being true.
 *
 * The cases are typed into the page rather than read from a file. They are a
 * question somebody is asking right now — "does the router still know these
 * apart" — and writing them to disk to answer it would make an experiment into
 * a commit.
 */

import { evaluateRouter, routerCaseSetSchema, type EvalReport } from 'yas-harness';

import { harness } from '../../lib/harness';

export interface EvalOutcome {
  readonly report: EvalReport | null;
  readonly error: string | null;
}

export async function runRouterEval(
  _previous: EvalOutcome | null,
  form: FormData,
): Promise<EvalOutcome> {
  try {
    const parsed: unknown = JSON.parse(String(form.get('cases') ?? '[]'));
    const cases = routerCaseSetSchema.parse(parsed);
    const api = await harness();
    return { report: await evaluateRouter(api.router, cases), error: null };
  } catch (error) {
    // Returned, not thrown: a malformed case set and a missing model key are
    // both ordinary answers to "run this", and neither deserves an error page.
    return { report: null, error: error instanceof Error ? error.message : String(error) };
  }
}
