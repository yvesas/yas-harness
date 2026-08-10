// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * One workflow: what it will do, and the box that starts it.
 *
 * The steps are shown with their prompts, unrendered. Somebody about to start a
 * run should be able to read what each agent will be told — including which
 * earlier step's answer gets pasted in — before pressing the button, not
 * afterwards in a trace.
 */

import { ArrowRightIcon, ClockIcon, RobotIcon } from '@phosphor-icons/react/dist/ssr';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

import { currentTenant } from '../../../lib/tenant';
import { harness } from '../../../lib/harness';
import { Failure } from '../../failure';
import { startRun } from '../actions';
import { RunStatusBadge, when } from '../status';

export const dynamic = 'force-dynamic';

export default async function Workflow({
  params,
  searchParams,
}: {
  readonly params: Promise<{ workflowId: string }>;
  readonly searchParams: Promise<{ error?: string }>;
}) {
  try {
    const { workflowId } = await params;
    const { error } = await searchParams;
    const tenant = await currentTenant();
    const api = await harness();
    const workflow = api.workflows.get(workflowId);

    if (!workflow) {
      return (
        <div className="space-y-3">
          <h1 className="text-2xl font-semibold tracking-tight">{workflowId}</h1>
          <p className="text-muted-foreground text-sm">
            No workflow with that id. It would be a file called{' '}
            <code className="text-foreground">config/workflows/{workflowId}.json</code>; a new one
            is picked up when the harness restarts.
          </p>
        </div>
      );
    }

    // Named here rather than at run time only: a workflow whose agent is
    // missing refuses to start, and reading that on the page beats reading it
    // in a banner after pressing the button.
    const known = new Set((await api.modules.list()).map((module) => module.id));
    const runs = (await api.workflowRuns.list(tenant.id, 100)).filter(
      (run) => run.workflowId === workflowId,
    );

    return (
      <div className="space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">{workflow.name}</h1>
          <p className="text-muted-foreground max-w-2xl text-sm">{workflow.description}</p>
        </header>

        {error ? (
          <p className="border-destructive/40 bg-destructive/10 rounded-md border px-3 py-2 text-sm">
            {error}
          </p>
        ) : null}

        <section className="space-y-3">
          <h2 className="text-lg font-medium">What it will do</h2>
          <div className="space-y-3">
            {workflow.steps.map((step, index) => {
              const missing = !known.has(step.agent);
              return (
                <Card key={step.id}>
                  <CardContent className="space-y-2 py-4">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-muted-foreground text-sm">{index + 1}</span>
                      <RobotIcon className="text-primary size-4" weight="fill" />
                      <code className="text-sm font-medium">{step.agent}</code>
                      <span className="text-muted-foreground text-xs">step {step.id}</span>
                      {step.approve ? (
                        <Badge variant="secondary">
                          <ClockIcon weight="fill" /> waits for you
                        </Badge>
                      ) : null}
                      {missing ? <Badge variant="destructive">agent not registered</Badge> : null}
                    </div>
                    <pre className="bg-muted text-muted-foreground overflow-x-auto rounded-md p-3 text-xs whitespace-pre-wrap">
                      {step.prompt}
                    </pre>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          <p className="text-muted-foreground text-sm">
            <code className="text-foreground">{'{{input}}'}</code> is what you type below;{' '}
            <code className="text-foreground">{'{{steps.<id>}}'}</code> is what an earlier step
            answered. Nothing else crosses between steps — each one runs in its own conversation, so
            one agent&rsquo;s tool results never reach another.
          </p>
        </section>

        <Card>
          <CardContent className="py-5">
            <form action={startRun} className="space-y-3">
              <input type="hidden" name="workflowId" value={workflow.id} />
              <label className="block space-y-1 text-sm">
                <span className="font-medium">{workflow.inputLabel}</span>
                <textarea
                  name="input"
                  rows={3}
                  required
                  className="border-input bg-background w-full rounded-md border px-3 py-2 text-sm"
                />
              </label>
              <div className="flex flex-wrap items-center gap-3">
                <Button type="submit">
                  <ArrowRightIcon /> Start the run
                </Button>
                <span className="text-muted-foreground text-sm">
                  The page waits until the run finishes or stops for you — with tool calls, that can
                  be a minute.
                </span>
              </div>
            </form>
          </CardContent>
        </Card>

        {runs.length > 0 ? (
          <section className="space-y-2">
            <h2 className="text-lg font-medium">Earlier runs</h2>
            <ul className="space-y-1 text-sm">
              {runs.map((run) => (
                <li key={run.id} className="flex flex-wrap items-center gap-2">
                  <a href={`/workflows/runs/${run.id}`}>{when(run.startedAt)}</a>
                  <RunStatusBadge status={run.status} />
                  <span className="text-muted-foreground truncate">{run.input}</span>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </div>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
