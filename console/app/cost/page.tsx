// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * What the tenant has spent, and where it went.
 *
 * This page used to state what it could not show. It asked, and `UsageReader`
 * grew `breakdown` and `savings` — which is the method doc 21 argued for: a
 * port shaped by the consumer that needed it, rather than by a guess about
 * what a consumer might one day want.
 */

import type { SpendSlice } from 'yas-harness';

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

const DAYS = 14;
const DEAREST_SESSIONS = 10;

export default async function Cost() {
  try {
    const tenant = await currentTenant();
    const api = await harness();
    const from = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000);

    const [spend, byModel, byTask, byDay, bySession, savings] = await Promise.all([
      api.usage.spend(tenant.id),
      api.usage.breakdown(tenant.id, { by: 'model' }),
      api.usage.breakdown(tenant.id, { by: 'task' }),
      api.usage.breakdown(tenant.id, { by: 'day', from }),
      api.usage.breakdown(tenant.id, { by: 'session', limit: DEAREST_SESSIONS }),
      api.usage.savings(tenant.id),
    ]);

    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Cost</h1>
        <div className="cards">
          <div className="card">
            <div className="text-muted-foreground text-sm">Total</div>
            <div className="value">${spend.totalCostUsd.toFixed(6)}</div>
          </div>
          <div className="card">
            <div className="text-muted-foreground text-sm">Calls</div>
            <div className="value">{spend.calls}</div>
          </div>
          <div className="card">
            <div className="text-muted-foreground text-sm">Input tokens</div>
            <div className="value">{spend.inputTokens}</div>
          </div>
          <div className="card">
            <div className="text-muted-foreground text-sm">Output tokens</div>
            <div className="value">{spend.outputTokens}</div>
          </div>
        </div>

        <h2 className="mt-8 text-lg font-semibold tracking-tight">By model</h2>
        <Slices slices={byModel} label="Model" empty="No calls recorded yet." />

        <h2 className="mt-8 text-lg font-semibold tracking-tight">By task</h2>
        <p className="text-muted-foreground text-sm">
          What routing is for: triage should stay on the cheap tier, and this is where that stops
          being true.
        </p>
        <Slices slices={byTask} label="Task" empty="No calls recorded yet." />

        <h2 className="mt-8 text-lg font-semibold tracking-tight">Last {DAYS} days</h2>
        <Slices
          slices={byDay}
          label="Day (UTC)"
          empty={`Nothing in the last ${String(DAYS)} days.`}
        />

        <h2 className="mt-8 text-lg font-semibold tracking-tight">Dearest conversations</h2>
        <Slices
          slices={bySession}
          label="Session"
          empty="No spend attributed to a conversation yet."
        />
        <p className="text-muted-foreground text-sm">
          Calls made outside a conversation — a routing decision, for instance — are absent here
          rather than gathered under a session that never existed. They are still in the total.
        </p>

        <h2 className="mt-8 text-lg font-semibold tracking-tight">Compression</h2>
        {savings === null ? (
          <p className="text-muted-foreground text-sm">
            Compression has never run for this tenant. That is not the same as it having saved
            nothing — it is off by default and stays off until an eval says answers hold.
          </p>
        ) : (
          <p>
            {savings.beforeTokens} tokens became {savings.afterTokens} across {savings.calls} call
            {savings.calls === 1 ? '' : 's'} —{' '}
            <strong>
              {(
                ((savings.beforeTokens - savings.afterTokens) / savings.beforeTokens) *
                100
              ).toFixed(1)}
              %
            </strong>{' '}
            off the context it touched.
          </p>
        )}
      </>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}

function Slices({
  slices,
  label,
  empty,
}: {
  slices: readonly SpendSlice[];
  label: string;
  empty: string;
}) {
  if (slices.length === 0) {
    return <p className="text-muted-foreground text-sm">{empty}</p>;
  }
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{label}</TableHead>
          <TableHead>Cost</TableHead>
          <TableHead>Calls</TableHead>
          <TableHead>In / out</TableHead>
          <TableHead>Cached in</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {slices.map((slice) => (
          <TableRow key={slice.key}>
            <TableCell>
              <code>{slice.key}</code>
            </TableCell>
            <TableCell>${slice.costUsd.toFixed(6)}</TableCell>
            <TableCell>{slice.calls}</TableCell>
            <TableCell>
              {slice.inputTokens} / {slice.outputTokens}
            </TableCell>
            <TableCell className="text-muted-foreground text-sm">
              {slice.cachedInputTokens}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
