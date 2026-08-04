// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The inbox — what is waiting on a person.
 *
 * This page is why `ApprovalStore.pending` exists. `list` answers about one
 * conversation, which is only useful to somebody who already knows which
 * conversation to look at. A person deciding does not: they have an inbox.
 *
 * Oldest first, because each row is a turn parked mid-flight with somebody
 * waiting on the other end.
 */

import { currentTenant } from '../../lib/tenant';
import { harness } from '../../lib/harness';
import { Failure } from '../failure';

export const dynamic = 'force-dynamic';

export default async function Approvals() {
  try {
    const tenant = await currentTenant();
    const waiting = await (await harness()).approvals.pending(tenant.id);

    return (
      <>
        <h1>Approvals</h1>
        {waiting.length === 0 ? (
          <p className="muted">
            Nothing is waiting. A tool marked <code>requiresApproval</code> parks its turn here
            before running anything; so does a write that arrives over MCP, which is refused and
            recorded rather than paused, because MCP has no turn to pause.
          </p>
        ) : (
          <>
            <p className="muted">Oldest first — each of these is a turn parked mid-flight.</p>
            <table>
              <thead>
                <tr>
                  <th>Asked</th>
                  <th>Tool</th>
                  <th>Where from</th>
                  <th />
                </tr>
              </thead>
              <tbody>
                {waiting.map((approval) => (
                  <tr key={approval.id}>
                    <td>{approval.requestedAt.toISOString().replace('T', ' ').slice(0, 19)}</td>
                    <td>
                      <code>{approval.toolName}</code>
                    </td>
                    <td className="muted">
                      {approval.toolCallId.startsWith('mcp:') ? 'MCP' : 'a conversation'}
                    </td>
                    <td>
                      <a href={`/approvals/${approval.id}`}>Review</a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
