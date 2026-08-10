// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * One decision, with what is needed to make it.
 *
 * Three things: the tool, the exact input it would run with, and the turn that
 * led here. A queue that shows only a tool name asks people to approve a verb,
 * and a reviewer who cannot see the input is a rubber stamp with extra steps.
 *
 * The input is shown as it is stored, and it was scrubbed by the redactor on the
 * way in. Scrubbing again on the way out would hide the difference between "the
 * secret was caught" and "the display is hiding it" — and this is the one screen
 * where a person is being asked to vouch for exactly these bytes.
 */

import { currentTenant } from '../../../lib/tenant';
import { harness } from '../../../lib/harness';
import { Failure } from '../../failure';
import { approve, reject } from '../actions';
import { Button } from '@/components/ui/button';

export const dynamic = 'force-dynamic';

export default async function Review({ params }: { params: Promise<{ approvalId: string }> }) {
  try {
    const { approvalId } = await params;
    const tenant = await currentTenant();
    const api = await harness();
    const approval = await api.approvals.find(tenant.id, approvalId);

    if (!approval) {
      return (
        <>
          <h1 className="text-2xl font-semibold tracking-tight">Not found</h1>
          <p className="text-muted-foreground text-sm">
            No approval with that id for this tenant — which is also what another tenant&rsquo;s
            approval looks like from here.
          </p>
          <p>
            <a href="/approvals">Back to the inbox</a>
          </p>
        </>
      );
    }

    // The turn this came from. Approvals do not carry a trace id, so the
    // session is the link — which is enough to open the turn and read it.
    const turns = await api.traceReader.recent(tenant.id, {
      sessionId: approval.sessionId,
      limit: 1,
    });
    const overMcp = approval.toolCallId.startsWith('mcp:');
    // A workflow's step gate goes into this same queue on purpose — one inbox
    // rather than two, because the second inbox is the one nobody watches. It
    // needs its own rendering, though: what is being approved is a prompt, and
    // a prompt inside escaped JSON is the one thing a reviewer cannot read.
    const step = asWorkflowStep(approval.toolName, approval.input);

    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">
          <code>{approval.toolName}</code>
        </h1>
        <p className="text-muted-foreground text-sm">
          Asked {approval.requestedAt.toISOString().replace('T', ' ').slice(0, 19)} · status{' '}
          <strong>{approval.status}</strong>
          {overMcp ? ' · arrived over MCP' : ''}
        </p>

        {step ? (
          <>
            <h2 className="mt-8 text-lg font-semibold tracking-tight">
              This would be sent to <code>{step.agent}</code>
            </h2>
            <pre className="bg-muted overflow-x-auto rounded-md p-3 text-sm whitespace-pre-wrap">
              {step.prompt}
            </pre>
            <p className="text-muted-foreground text-sm">
              Nothing has been sent to a model for this step yet. Approving lets it run; the run
              then carries on to whatever follows.
            </p>
            <p>
              <a href={`/workflows/runs/${step.runId}`}>Open the run this belongs to</a>
            </p>
          </>
        ) : (
          <>
            <h2 className="mt-8 text-lg font-semibold tracking-tight">It would run with</h2>
            <pre className="bg-muted overflow-x-auto rounded-md p-3 text-sm">
              {JSON.stringify(approval.input, null, 2)}
            </pre>
          </>
        )}
        {overMcp ? (
          <p className="text-muted-foreground text-sm">
            Approving covers <strong>these arguments</strong>, not this tool. A client sending
            anything else asks again — which is what stops approval for something harmless being
            spent on something else.
          </p>
        ) : null}

        {turns[0] ? (
          <p>
            <a href={`/traces/${turns[0].traceId}`}>Open the turn that led here</a>
          </p>
        ) : step ? null : (
          <p className="text-muted-foreground text-sm">No trace recorded for this conversation.</p>
        )}

        {approval.status === 'pending' ? (
          <>
            <h2 className="mt-8 text-lg font-semibold tracking-tight">Decide</h2>
            <form action={approve}>
              <input type="hidden" name="approvalId" value={approval.id} />
              <label>
                Reason (optional for yes, and worth writing for no)
                <br />
                <input type="text" name="reason" size={60} />
              </label>{' '}
              <Button type="submit" size="sm">
                Approve
              </Button>
            </form>
            <form action={reject}>
              <input type="hidden" name="approvalId" value={approval.id} />
              <input type="hidden" name="reason" value="" />
              <Button type="submit" size="sm">
                Reject
              </Button>
            </form>
            <p className="text-muted-foreground text-sm">
              A rejection should carry a reason: it is the answer somebody has to act on, and
              &ldquo;no&rdquo; with nothing attached gets retried forever. Type it above before
              rejecting.
            </p>
          </>
        ) : (
          <>
            <h2 className="mt-8 text-lg font-semibold tracking-tight">Decided</h2>
            <p>
              {approval.status} by <code>{approval.decidedBy}</code> at{' '}
              {approval.decidedAt?.toISOString().replace('T', ' ').slice(0, 19)}
              {approval.reason ? ` — ${approval.reason}` : ''}
            </p>
          </>
        )}

        <p>
          <a href="/approvals">Back to the inbox</a>
        </p>
      </>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}

/**
 * A workflow step gate, when that is what this is.
 *
 * Read defensively rather than cast: the input column is jsonb written by the
 * harness, and a page that trusted its shape would crash on a row written by an
 * older version of it.
 */
function asWorkflowStep(
  toolName: string,
  input: unknown,
): { readonly runId: string; readonly agent: string; readonly prompt: string } | null {
  if (!toolName.startsWith('workflow.') || typeof input !== 'object' || input === null) {
    return null;
  }
  const { runId, agent, prompt } = input as Record<string, unknown>;
  if (typeof runId !== 'string' || typeof agent !== 'string' || typeof prompt !== 'string') {
    return null;
  }
  return { runId, agent, prompt };
}
