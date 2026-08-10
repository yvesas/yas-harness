// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * One run: what each agent was asked, what it answered, and what is holding it.
 *
 * The prompt shown is the one that actually ran, read from the run rather than
 * re-rendered from the config — the workflow file is versioned in Git and will
 * be edited, and "what was this agent told" has to stay answerable about a run
 * from three months ago.
 */

import { ArrowClockwiseIcon, ClockIcon, WarningIcon } from '@phosphor-icons/react/dist/ssr';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

import { currentTenant } from '../../../../lib/tenant';
import { harness } from '../../../../lib/harness';
import { Failure } from '../../../failure';
import { resumeRun } from '../../actions';
import { RunStatusBadge, when } from '../../status';

export const dynamic = 'force-dynamic';

export default async function Run({
  params,
  searchParams,
}: {
  readonly params: Promise<{ runId: string }>;
  readonly searchParams: Promise<{ error?: string }>;
}) {
  try {
    const { runId } = await params;
    const { error } = await searchParams;
    const tenant = await currentTenant();
    const api = await harness();
    const detail = await api.workflowRunner.detail(tenant.id, runId);

    if (!detail) {
      return (
        <div className="space-y-3">
          <h1 className="text-2xl font-semibold tracking-tight">Run not found</h1>
          <p className="text-muted-foreground text-sm">
            No run with that id belongs to this tenant.
          </p>
        </div>
      );
    }

    const { run, steps } = detail;
    const workflow = api.workflows.get(run.workflowId);
    const held = steps.find((step) => step.status === 'awaiting_approval');
    const approval =
      held?.approvalId === null || held?.approvalId === undefined
        ? null
        : await api.approvals.find(tenant.id, held.approvalId);

    return (
      <div className="space-y-6">
        <header className="space-y-2">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-2xl font-semibold tracking-tight">
              {workflow?.name ?? run.workflowId}
            </h1>
            <RunStatusBadge status={run.status} />
          </div>
          <p className="text-muted-foreground text-sm">
            Started {when(run.startedAt)}
            {run.startedBy ? ` by ${run.startedBy}` : ''}
            {run.finishedAt ? `, finished ${when(run.finishedAt)}` : ''}.
          </p>
          <p className="text-sm">
            <span className="text-muted-foreground">Asked about: </span>
            {run.input}
          </p>
        </header>

        {error ? (
          <p className="border-destructive/40 bg-destructive/10 rounded-md border px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}

        {run.error ? (
          <p className="border-destructive/40 bg-destructive/10 flex items-start gap-2 rounded-md border px-3 py-2 text-sm">
            <WarningIcon className="mt-0.5 size-4 shrink-0" weight="fill" />
            <span>{run.error}</span>
          </p>
        ) : null}

        {run.status === 'awaiting_approval' && held ? (
          <Card>
            <CardContent className="space-y-3 py-5">
              <div className="flex items-center gap-2">
                <ClockIcon className="size-5" weight="fill" />
                <span className="font-medium">
                  Waiting on you, at step <code>{held.stepId}</code>
                </span>
              </div>
              <p className="text-muted-foreground text-sm">
                {held.awaiting === 'step'
                  ? 'Nothing has been sent to a model for this step. The decision is whether it should run at all — the prompt below is exactly what would be sent.'
                  : 'The step is half done: its agent asked to run something that needs a person, and the call is held.'}
              </p>
              {approval ? (
                <p className="text-sm">
                  Decide it in{' '}
                  <a href={`/approvals/${approval.id}`} className="underline">
                    Approvals
                  </a>
                  {approval.status === 'pending' ? '' : ` — already ${approval.status}`}.
                </p>
              ) : (
                <p className="text-sm">
                  Decide it in{' '}
                  <a href="/approvals" className="underline">
                    Approvals
                  </a>
                  .
                </p>
              )}
              <form action={resumeRun}>
                <input type="hidden" name="runId" value={run.id} />
                <Button type="submit" variant="secondary">
                  <ArrowClockwiseIcon /> Carry on from here
                </Button>
              </form>
              <p className="text-muted-foreground text-xs">
                Press this after deciding. Nothing is lost while it waits — the whole state of the
                run is stored, so it survives a restart.
              </p>
            </CardContent>
          </Card>
        ) : null}

        <section className="space-y-3">
          <h2 className="text-lg font-medium">Steps</h2>
          {steps.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing ran.</p>
          ) : (
            steps.map((step) => (
              <Card key={step.id}>
                <CardContent className="space-y-3 py-4">
                  <div className="flex flex-wrap items-center gap-2">
                    <code className="text-sm font-medium">{step.stepId}</code>
                    <span className="text-muted-foreground text-sm">as {step.agentId}</span>
                    <RunStatusBadge status={step.status} />
                    {step.traceId ? (
                      <a href={`/traces/${step.traceId}`} className="text-sm underline">
                        trace
                      </a>
                    ) : null}
                  </div>

                  <div className="space-y-1">
                    <div className="text-muted-foreground text-xs font-medium">Asked</div>
                    <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs whitespace-pre-wrap">
                      {step.prompt}
                    </pre>
                  </div>

                  {step.output === null ? null : (
                    <div className="space-y-1">
                      <div className="text-muted-foreground text-xs font-medium">Answered</div>
                      <pre className="bg-muted overflow-x-auto rounded-md p-3 text-xs whitespace-pre-wrap">
                        {step.output}
                      </pre>
                    </div>
                  )}

                  {step.error ? <p className="text-destructive text-sm">{step.error}</p> : null}
                </CardContent>
              </Card>
            ))
          )}
        </section>
      </div>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
