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

export const dynamic = 'force-dynamic';

export default async function Playground() {
  try {
    const tenant = await currentTenant();
    const sessions = await (await harness()).sessions.list(tenant.id, { limit: 20 });

    return (
      <>
        <h1>Playground</h1>
        <p className="muted">
          Talk to the agent and watch the trace beside it: input, the routing decision, every model
          call, every tool, and how the turn ended. It is the loop the harness is for — configure,
          converse, read what happened, adjust.
        </p>

        <form action={startConversation}>
          <button type="submit">New conversation</button>
        </form>

        <h2>Recent</h2>
        {sessions.length === 0 ? (
          <p className="muted">No conversations yet.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Last activity</th>
                <th>Messages</th>
                <th>Persona</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sessions.map((session) => (
                <tr key={session.id}>
                  <td>{session.lastActivityAt.toISOString().replace('T', ' ').slice(0, 19)}</td>
                  <td>{session.messages}</td>
                  <td className="muted">
                    <code>{session.personaId}</code>
                  </td>
                  <td>
                    <a href={`/playground/${session.id}`}>Open</a>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <p className="muted">
          Ordered by last activity, not by when they were opened: a conversation replied to this
          morning matters more than one started last week and abandoned.
        </p>
      </>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
