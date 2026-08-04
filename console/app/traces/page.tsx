// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Every turn the harness has recorded lately.
 *
 * This page is why `TraceReader.recent` exists. A reader that can only answer
 * about a turn whose id you already hold is useful to exactly one caller — the
 * one that just ran it — and "what happened lately" is the question anybody
 * else has.
 */

import { currentTenant } from '../../lib/tenant';
import { harness } from '../../lib/harness';
import { Failure } from '../failure';

export const dynamic = 'force-dynamic';

const PAGE_SIZE = 50;

export default async function Traces() {
  try {
    const tenant = await currentTenant();
    const turns = await (await harness()).traceReader.recent(tenant.id, { limit: PAGE_SIZE });

    return (
      <>
        <h1>Traces</h1>
        <p className="muted">
          One row per turn, newest first. A turn that died half way still appears — steps are
          appended as they happen, so the trace shows how far it got.
        </p>
        {turns.length === 0 ? (
          <p className="muted">No turns recorded for this tenant.</p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Session</th>
                <th>Steps</th>
                <th>Ended as</th>
              </tr>
            </thead>
            <tbody>
              {turns.map((turn) => (
                <tr key={turn.traceId}>
                  <td>
                    <a href={`/traces/${turn.traceId}`}>
                      {turn.startedAt.toISOString().replace('T', ' ').slice(0, 19)}
                    </a>
                  </td>
                  <td className="muted">
                    <code>{turn.sessionId?.slice(0, 8) ?? 'none'}</code>
                  </td>
                  <td>{turn.steps}</td>
                  <td className={turn.failed ? 'failed' : undefined}>
                    {turn.endedAs ?? 'did not finish'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
