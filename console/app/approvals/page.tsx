// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The inbox — and whose move it is.
 *
 * This page is why `ApprovalStore.pending` exists. `list` answers about one
 * conversation, which is only useful to somebody who already knows which
 * conversation to look at. A person deciding does not: they have an inbox.
 *
 * Three segments rather than one list, because a single queue mixes two
 * different asks. **Needs you** is blocked on a person and nothing moves until
 * they act. **Waiting on the agent** is a call sent back for changes — already
 * answered, and the next move is the model's. **Decided** is history. Mixing
 * them puts rows nobody has to touch in front of rows that are blocking a turn.
 *
 * The headings say *you* on purpose. "Pending approval" hides whose move it is
 * behind the passive voice; the reader of this page *is* the review, and a
 * label that will not say so makes them work out their own job.
 */

import type { Approval } from 'yas-harness';

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

/** Where a gated call came from, said in words rather than in an id prefix. */
function origin(approval: Approval): string {
  if (approval.toolCallId.startsWith('mcp:')) return 'MCP';
  if (approval.toolName.startsWith('workflow.')) return 'a workflow step';
  return 'a conversation';
}

function when(at: Date): string {
  return at.toISOString().replace('T', ' ').slice(0, 19);
}

/**
 * High risk first, then longest-blocked.
 *
 * Only in the segment that is blocked on a person: elsewhere the row is
 * history, and history reads newest first.
 */
const RISK_ORDER = { high: 0, medium: 1, low: 2, none: 3 } as const;

function byUrgency(a: Approval, b: Approval): number {
  return (
    RISK_ORDER[a.risk] - RISK_ORDER[b.risk] || a.requestedAt.getTime() - b.requestedAt.getTime()
  );
}

function Segment({
  title,
  blurb,
  rows,
  actionable,
}: {
  title: string;
  blurb: string;
  rows: Approval[];
  actionable: boolean;
}) {
  if (rows.length === 0) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-lg font-semibold tracking-tight">
        {title} <span className="text-muted-foreground font-normal">({rows.length})</span>
      </h2>
      <p className="text-muted-foreground text-sm">{blurb}</p>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Asked</TableHead>
            <TableHead>Risk</TableHead>
            <TableHead>What it would do</TableHead>
            <TableHead>Where from</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((approval) => (
            <TableRow key={approval.id}>
              <TableCell>{when(approval.requestedAt)}</TableCell>
              <TableCell className={approval.risk === 'high' ? 'font-semibold' : undefined}>
                {approval.risk}
              </TableCell>
              <TableCell>
                {/* The sentence if the tool wrote one; the tool name only as a
                    fallback, and marked as the fallback it is — approving on a
                    name alone is rubber-stamping. */}
                {approval.consequence ?? (
                  <span className="text-muted-foreground">
                    <code>{approval.toolName}</code> — no description
                  </span>
                )}
              </TableCell>
              <TableCell className="text-muted-foreground text-sm">{origin(approval)}</TableCell>
              <TableCell>
                <a href={`/approvals/${approval.id}`}>{actionable ? 'Review' : 'Open'}</a>
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </section>
  );
}

export default async function Approvals() {
  try {
    const tenant = await currentTenant();
    const all = await (await harness()).approvals.recent(tenant.id);

    const needsYou = all.filter((a) => a.status === 'pending').sort(byUrgency);
    const waiting = all.filter((a) => a.status === 'changes_requested');
    const decided = all.filter((a) => a.status === 'approved' || a.status === 'rejected');

    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Approvals</h1>
        {all.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            Nothing is waiting. A tool marked <code>requiresApproval</code> parks its turn here
            before running anything; so does a write that arrives over MCP, which is refused and
            recorded rather than paused, because MCP has no turn to pause.
          </p>
        ) : (
          <div className="space-y-8">
            <Segment
              title="Needs you"
              blurb="Riskiest first, then whichever has been blocked longest. Each of these is a turn parked mid-flight."
              rows={needsYou}
              actionable
            />
            <Segment
              title="Waiting on the agent"
              blurb="You asked for changes. The model has the note and has not come back yet — nothing here needs you."
              rows={waiting}
              actionable={false}
            />
            <Segment
              title="Decided"
              blurb="Already answered. Here so a decision can be looked up, not because anything is expected of you."
              rows={decided}
              actionable={false}
            />
          </div>
        )}
      </>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
