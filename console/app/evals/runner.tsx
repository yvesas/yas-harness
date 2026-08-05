// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

'use client';

/**
 * The case set, and what the router did with it.
 *
 * A failure shows what was expected, what was chosen, and how sure the router
 * was — because a wrong answer at high confidence and a wrong answer at low
 * confidence call for different fixes. The first is a description that misleads;
 * the second is a case that genuinely is ambiguous.
 */

import { useActionState } from 'react';

import { runRouterEval, type EvalOutcome } from './actions';

export function RouterEval({
  modules,
}: {
  modules: readonly { id: string; description: string }[];
}) {
  const [outcome, action, pending] = useActionState<EvalOutcome | null, FormData>(
    runRouterEval,
    null,
  );

  const starter = JSON.stringify(
    modules.slice(0, 2).map((module) => ({
      input: `something about ${module.id}`,
      expected: module.id,
    })),
    null,
    2,
  );

  return (
    <>
      <form action={action}>
        <textarea
          name="cases"
          defaultValue={starter}
          rows={12}
          spellCheck={false}
          style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: '0.85rem' }}
        />
        <button type="submit" disabled={pending}>
          {pending ? 'Running…' : 'Run'}
        </button>
      </form>

      {outcome?.error ? <p className="failed">{outcome.error}</p> : null}

      {outcome?.report ? (
        <>
          <h2>
            {outcome.report.correct} of {outcome.report.total} —{' '}
            {(outcome.report.accuracy * 100).toFixed(0)}%
          </h2>
          <table>
            <thead>
              <tr>
                <th />
                <th>Input</th>
                <th>Expected</th>
                <th>Chose</th>
                <th>Confidence</th>
              </tr>
            </thead>
            <tbody>
              {outcome.report.outcomes.map((entry, index) => (
                <tr key={index}>
                  <td className={entry.correct ? undefined : 'failed'}>
                    {entry.correct ? '✓' : '✗'}
                  </td>
                  <td>{entry.input}</td>
                  <td>
                    <code>{entry.expected}</code>
                  </td>
                  <td>
                    <code>{entry.actual ?? '—'}</code>
                    {entry.error ? <div className="failed">{entry.error}</div> : null}
                  </td>
                  <td className="muted">
                    {entry.confidence === null ? '' : entry.confidence.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          <p className="muted">
            Confidence is worth reading next to a failure. Wrong and sure is a module description
            that misleads the router; wrong and unsure is a case that is genuinely ambiguous, and
            the fix is in different places.
          </p>
        </>
      ) : null}
    </>
  );
}
