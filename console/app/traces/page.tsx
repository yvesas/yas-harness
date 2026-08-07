// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Every turn the harness has recorded lately.
 *
 * This page is why `TraceReader.recent` exists. A reader that can only answer
 * about a turn whose id you already hold is useful to exactly one caller — the
 * one that just ran it — and "what happened lately" is the question anybody
 * else has.
 */

import { currentTenant } from '../../lib/tenant';
import { harness } from '../../lib/harness';
import { Failure } from '../failure';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function Traces() {
  try {
    const tenant = await currentTenant();
    const turns = await (await harness()).traceReader.recent(tenant.id, { limit: PAGE_SIZE });

    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Traces</h1>
        <p className="text-muted-foreground text-sm">
          One row per turn, newest first. A turn that died half way still appears — steps are
          appended as they happen, so the trace shows how far it got.
        </p>
        {turns.length === 0 ? (
          <p className="text-muted-foreground text-sm">No turns recorded for this tenant.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Session</TableHead>
                <TableHead>Steps</TableHead>
                <TableHead>Ended as</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {turns.map((turn) => (
                <TableRow key={turn.traceId}>
                  <TableCell>
                    <a href={`/traces/${turn.traceId}`}>
                      {turn.startedAt.toISOString().replace('T', ' ').slice(0, 19)}
                    </a>
                  </TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    <code>{turn.sessionId?.slice(0, 8) ?? 'none'}</code>
                  </TableCell>
                  <TableCell>{turn.steps}</TableCell>
                  <TableCell className={turn.failed ? 'text-destructive' : undefined}>
                    {turn.endedAs ?? 'did not finish'}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
