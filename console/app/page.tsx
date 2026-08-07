// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Overview: spend, the last few turns, and whether anything is broken.
 *
 * Everything here comes through a harness **port**. That is the point of the
 * console as a boundary test: the first place this file needs a raw
 * `pool.query()` is a gap in the harness, not a thing to work around here.
 */

import { ArrowRightIcon } from '@phosphor-icons/react/dist/ssr';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { currentTenant } from '../lib/tenant';
import { harness } from '../lib/harness';
import { Failure } from './failure';

export const dynamic = 'force-dynamic';

const RECENT_TURNS = 8;

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'bad' }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-muted-foreground text-sm font-medium">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <div
          className={`text-2xl font-semibold tabular-nums ${tone === 'bad' ? 'text-destructive' : ''}`}
        >
          {value}
        </div>
      </CardContent>
    </Card>
  );
}

export default async function Overview() {
  try {
    const [tenant, api] = [await currentTenant(), await harness()];
    const [spend, recent] = await Promise.all([
      api.usage.spend(tenant.id),
      api.traceReader.recent(tenant.id, { limit: RECENT_TURNS }),
    ]);
    const failed = recent.filter((turn) => turn.failed).length;

    return (
      <div className="space-y-8">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{tenant.name}</h1>
          <p className="text-muted-foreground mt-1 text-sm">
            Acting as <code className="text-foreground">{tenant.slug}</code>. There is no login yet
            — one function decides this, so adding real authentication is a change in one place.
          </p>
        </div>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Spend" value={`$${spend.totalCostUsd.toFixed(4)}`} />
          <Stat label="Model calls" value={String(spend.calls)} />
          <Stat
            label="Tokens in / out"
            value={`${String(spend.inputTokens)} / ${String(spend.outputTokens)}`}
          />
          <Stat
            label="Recent turns that failed"
            value={`${String(failed)} of ${String(recent.length)}`}
            {...(failed > 0 ? { tone: 'bad' as const } : {})}
          />
        </div>

        <section className="space-y-3">
          <h2 className="text-lg font-semibold tracking-tight">Recent turns</h2>
          {recent.length === 0 ? (
            <p className="text-muted-foreground text-sm">
              Nothing has run yet. Spend is recorded per call and traces per turn, so both fill in
              as soon as the agent answers something.
            </p>
          ) : (
            <Card>
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Started</TableHead>
                    <TableHead>Steps</TableHead>
                    <TableHead>Ended as</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {recent.map((turn) => (
                    <TableRow key={turn.traceId}>
                      <TableCell className="tabular-nums">
                        {turn.startedAt.toISOString().replace('T', ' ').slice(0, 19)}
                      </TableCell>
                      <TableCell>{turn.steps}</TableCell>
                      <TableCell>
                        <Badge variant={turn.failed ? 'destructive' : 'secondary'}>
                          {turn.endedAs ?? 'did not finish'}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right">
                        <a
                          href={`/traces/${turn.traceId}`}
                          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-sm"
                        >
                          open <ArrowRightIcon className="size-3" />
                        </a>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </Card>
          )}
        </section>
      </div>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
