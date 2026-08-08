// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The agents you have assembled.
 *
 * This is the screen the whole declarative-agent work was for: a person adds an
 * agent without writing TypeScript and without forking anything. What it writes
 * is a file in `config/agents/`, versioned in Git — the console is an editor
 * over files, not a replacement for them.
 */

import { PlusIcon, RobotIcon, ShieldCheckIcon } from '@phosphor-icons/react/dist/ssr';

import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';

import { listAgents } from '../../lib/agent-files';
import { Failure } from '../failure';

export const dynamic = 'force-dynamic';

export default async function Agents() {
  try {
    const agents = await listAgents();

    return (
      <div className="space-y-6">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">Agents</h1>
            <p className="text-muted-foreground max-w-2xl text-sm">
              Each one is a model, a prompt, and the sources it may reach. The router reads their
              descriptions and hands a turn to whichever fits — so what you write in a description
              is what decides when an agent is used.
            </p>
          </div>
          <Button size="sm" render={<a href="/agents/new" />}>
            <PlusIcon /> New agent
          </Button>
        </header>

        {agents.length === 0 ? (
          <Card>
            <CardContent className="text-muted-foreground space-y-2 py-8 text-center text-sm">
              <p>No agents yet.</p>
              <p>
                An agent needs no code: its tools are the six generic operations — list, read,
                search, create, update, delete — over the sources you grant it.
              </p>
            </CardContent>
          </Card>
        ) : (
          <div className="grid gap-4 md:grid-cols-2">
            {agents.map((agent) => {
              const writes = agent.connections.some((grant) =>
                grant.can.some((capability) => ['create', 'update', 'delete'].includes(capability)),
              );
              return (
                <a key={agent.id} href={`/agents/${agent.id}`} className="group">
                  <Card className="hover:border-primary/50 h-full transition-colors">
                    <CardContent className="space-y-3 py-5">
                      <div className="flex items-center gap-2">
                        <RobotIcon className="text-primary size-5" weight="fill" />
                        <span className="font-medium">{agent.name}</span>
                        <code className="text-muted-foreground text-xs">{agent.id}</code>
                        {writes && agent.approveWrites ? (
                          <Badge variant="secondary" className="ml-auto">
                            <ShieldCheckIcon weight="fill" /> writes ask first
                          </Badge>
                        ) : null}
                        {writes && !agent.approveWrites ? (
                          <Badge variant="destructive" className="ml-auto">
                            writes unattended
                          </Badge>
                        ) : null}
                      </div>

                      <p className="text-muted-foreground text-sm">{agent.description}</p>

                      <div className="flex flex-wrap gap-1">
                        {agent.connections.length === 0 ? (
                          <span className="text-muted-foreground text-sm">
                            No sources — it answers from the conversation alone.
                          </span>
                        ) : (
                          agent.connections.map((grant) => (
                            <Badge key={grant.connectorId} variant="outline">
                              {grant.connectorId}: {grant.can.join(' ')}
                            </Badge>
                          ))
                        )}
                      </div>
                    </CardContent>
                  </Card>
                </a>
              );
            })}
          </div>
        )}

        <p className="text-muted-foreground text-sm">
          These are files in <code className="text-foreground">config/agents/</code>, one per agent,
          versioned in Git. Editing them with an editor keeps working — the console writes the same
          file, validated with the harness&rsquo;s own parser before it touches the disk.
        </p>
      </div>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
