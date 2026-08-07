// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Conversations.
 *
 * This page is why `SessionStore.list` exists — the fourth port a console page
 * has asked for. `find` answers about a session whose id you already hold,
 * which is only true of the one you just created; coming back to a playground
 * starts from "which conversations are there".
 */

import { currentTenant } from '../../lib/tenant';
import { harness } from '../../lib/harness';
import { Failure } from '../failure';
import { startConversation } from './actions';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const dynamic = 'force-dynamic';

export default async function Playground() {
  try {
    const tenant = await currentTenant();
    const sessions = await (await harness()).sessions.list(tenant.id, { limit: 20 });

    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Playground</h1>
        <p className="text-muted-foreground text-sm">
          Talk to the agent and watch the trace beside it: input, the routing decision, every model
          call, every tool, and how the turn ended. It is the loop the harness is for — configure,
          converse, read what happened, adjust.
        </p>

        <form action={startConversation}>
          <Button type="submit" size="sm">
            New conversation
          </Button>
        </form>

        <h2 className="mt-8 text-lg font-semibold tracking-tight">Recent</h2>
        {sessions.length === 0 ? (
          <p className="text-muted-foreground text-sm">No conversations yet.</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Last activity</TableHead>
                <TableHead>Messages</TableHead>
                <TableHead>Persona</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((session) => (
                <TableRow key={session.id}>
                  <TableCell>
                    {session.lastActivityAt.toISOString().replace('T', ' ').slice(0, 19)}
                  </TableCell>
                  <TableCell>{session.messages}</TableCell>
                  <TableCell className="text-muted-foreground text-sm">
                    <code>{session.personaId}</code>
                  </TableCell>
                  <TableCell>
                    <a href={`/playground/${session.id}`}>Open</a>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
        <p className="text-muted-foreground text-sm">
          Ordered by last activity, not by when they were opened: a conversation replied to this
          morning matters more than one started last week and abandoned.
        </p>
      </>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
