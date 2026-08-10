// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Workflows you can run, and what has run.
 *
 * The list on the left comes from `config/workflows/`, versioned in Git; the
 * runs come from the database. Both on one page because the question a person
 * arrives with is usually "did last night's summary go out", not "which
 * workflows exist".
 */

import { ArrowRightIcon, ClockIcon, PlayIcon } from '@phosphor-icons/react/dist/ssr';

import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

import { currentTenant } from '../../lib/tenant';
import { harness } from '../../lib/harness';
import { Failure } from '../failure';
import { RunStatusBadge, when } from './status';

export const dynamic = 'force-dynamic';

export default async function Workflows() {
  try {
    const tenant = await currentTenant();
    const api = await harness();
    const workflows = [...api.workflows.values()];
    const runs = await api.workflowRuns.list(tenant.id);
    const names = new Map(workflows.map((workflow) => [workflow.id, workflow.name]));

    return (
      <div className="space-y-6">
        <header className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">Workflows</h1>
          <p className="text-muted-foreground max-w-2xl text-sm">
            One agent answering one question is a chat. A workflow is several agents in order — each
            with its own tools and its own conversation — and somewhere for you to stand before the
            last one acts.
          </p>
        </header>

        {workflows.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground space-y-2 py-8 text-center text-sm">
              <p>No workflows yet.</p>
              <p>
                They are files in <code className="text-foreground">config/workflows/</code>, one
                per workflow. Copy{' '}
                <code className="text-foreground">weekly-summary.json.example</code> and restart to
                pick it up.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {workflows.map((workflow) => (
              <a key={workflow.id} href={`/workflows/${workflow.id}`} className="group">
                <Card className="hover:border-primary/50 h-full transition-colors">
                  <CardContent className="space-y-3 py-5">
                    <div className="flex items-center gap-2">
                      <PlayIcon className="text-primary size-5" weight="fill" />
                      <span className="font-medium">{workflow.name}</span>
                      <code className="text-muted-foreground text-xs">{workflow.id}</code>
                    </div>
                    <p className="text-muted-foreground text-sm">{workflow.description}</p>
                    <div className="flex flex-wrap items-center gap-1">
                      {workflow.steps.map((step, index) => (
                        <span key={step.id} className="flex items-center gap-1">
                          {index > 0 ? (
                            <ArrowRightIcon className="text-muted-foreground size-3" />
                          ) : null}
                          <Badge variant={step.approve ? 'secondary' : 'outline'}>
                            {step.approve ? <ClockIcon weight="fill" /> : null}
                            {step.agent}
                          </Badge>
                        </span>
                      ))}
                    </div>
                  </CardContent>
                </Card>
              </a>
            ))}
          </div>
        )}

        <section className="space-y-3">
          <h2 className="text-lg font-medium">Runs</h2>
          {runs.length === 0 ? (
            <p className="text-muted-foreground text-sm">Nothing has run yet.</p>
          ) : (
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Started</TableHead>
                  <TableHead>Workflow</TableHead>
                  <TableHead>Asked about</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead />
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.map((run) => (
                  <TableRow key={run.id}>
                    <TableCell className="whitespace-nowrap">{when(run.startedAt)}</TableCell>
                    <TableCell>{names.get(run.workflowId) ?? run.workflowId}</TableCell>
                    <TableCell className="max-w-xs truncate">{run.input}</TableCell>
                    <TableCell>
                      <RunStatusBadge status={run.status} />
                    </TableCell>
                    <TableCell>
                      <a href={`/workflows/runs/${run.id}`}>Open</a>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          )}
        </section>
      </div>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
