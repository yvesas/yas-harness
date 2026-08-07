// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * One turn, step by step: input → route → model → tools → end.
 *
 * A flat ordered list, because that is what a trace is. Rendering it as a tree
 * would mean inventing a nesting the recorder deliberately does not claim.
 *
 * Nothing is redacted here. It does not need to be: `detail` and `errorMessage`
 * went through the redactor on the way *in*, so what is stored is already
 * scrubbed — and re-scrubbing on read would hide the difference between "the
 * secret was caught" and "the display is hiding it".
 */

import { currentTenant } from '../../../lib/tenant';
import { harness } from '../../../lib/harness';
import { Failure } from '../../failure';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const dynamic = 'force-dynamic';

export default async function Trace({ params }: { params: Promise<{ traceId: string }> }) {
  try {
    const { traceId } = await params;
    const tenant = await currentTenant();
    const steps = await (await harness()).traceReader.trace(tenant.id, traceId);

    if (steps.length === 0) {
      return (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">Turn not found</h1>
          <p className="text-muted-foreground text-sm">
            No steps under <code>{traceId}</code> for this tenant. A trace is scoped to its tenant,
            so this is also what another tenant&rsquo;s turn looks like from here.
          </p>
        </>
      );
    }

    const total = steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);

    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Turn</h1>
        <p className="text-muted-foreground text-sm">
          <code>{traceId}</code> · {steps.length} steps · {total}ms of measured work
        </p>
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>#</TableHead>
              <TableHead>Step</TableHead>
              <TableHead>What</TableHead>
              <TableHead>Took</TableHead>
              <TableHead>Detail</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {steps.map((step) => (
              <TableRow key={step.sequence}>
                <TableCell className="text-muted-foreground text-sm">{step.sequence}</TableCell>
                <TableCell className={step.succeeded ? undefined : 'text-destructive'}>
                  {step.kind}
                </TableCell>
                <TableCell>
                  <code>{step.label ?? '—'}</code>
                </TableCell>
                <TableCell>
                  {step.durationMs === undefined ? '—' : `${step.durationMs}ms`}
                </TableCell>
                <TableCell>
                  {step.errorMessage ? (
                    <div className="text-destructive">{step.errorMessage}</div>
                  ) : null}
                  {step.detail ? (
                    <code className="text-muted-foreground text-sm">
                      {JSON.stringify(step.detail)}
                    </code>
                  ) : null}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
        <p className="text-muted-foreground text-sm">
          Measured work is the sum of the steps that reported a duration, not wall-clock for the
          turn — a step that never returned reports nothing.
        </p>
      </>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
