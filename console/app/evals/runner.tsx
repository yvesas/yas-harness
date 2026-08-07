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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { Button } from '@/components/ui/button';

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
        <Button size="sm" type="submit" disabled={pending}>
          {pending ? 'Running…' : 'Run'}
        </Button>
      </form>

      {outcome?.error ? <p className="text-destructive">{outcome.error}</p> : null}

      {outcome?.report ? (
        <>
          <h2 className="mt-8 text-lg font-semibold tracking-tight">
            {outcome.report.correct} of {outcome.report.total} —{' '}
            {(outcome.report.accuracy * 100).toFixed(0)}%
          </h2>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead />
                <TableHead>Input</TableHead>
                <TableHead>Expected</TableHead>
                <TableHead>Chose</TableHead>
                <TableHead>Confidence</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {outcome.report.outcomes.map((entry, index) => (
                <TableRow key={index}>
                  <TableCell className={entry.correct ? undefined : 'text-destructive'}>
                    {entry.correct ? '✓' : '✗'}
                  </TableCell>
                  <TableCell>{entry.input}</TableCell>
                  <TableCell>
                    <code>{entry.expected}</code>
                  </TableCell>
                  <TableCell>
                    <code>{entry.actual ?? '—'}</code>
                    {entry.error ? <div className="text-destructive">{entry.error}</div> : null}
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    {entry.confidence === null ? '' : entry.confidence.toFixed(2)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
          <p className="text-muted-foreground text-sm">
            Confidence is worth reading next to a failure. Wrong and sure is a module description
            that misleads the router; wrong and unsure is a case that is genuinely ambiguous, and
            the fix is in different places.
          </p>
        </>
      ) : null}
    </>
  );
}
