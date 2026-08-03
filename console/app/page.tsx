// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Overview: spend, the last few turns, and whether anything is broken.
 *
 * Everything here comes through a harness **port**. That is the point of the
 * console as a boundary test: the first place this file needs a raw
 * `pool.query()` is a gap in the harness, not a thing to work around here.
 */

import { currentTenant } from '../lib/tenant';
import { harness } from '../lib/harness';
import { Failure } from './failure';

export const dynamic = 'force-dynamic';

const RECENT_TURNS = 8;

export default async function Overview() {
  try {
    const [tenant, api] = [await currentTenant(), await harness()];
    const [spend, recent] = await Promise.all([
      api.usage.spend(tenant.id),
      api.traceReader.recent(tenant.id, { limit: RECENT_TURNS }),
    ]);
    const failed = recent.filter((turn) => turn.failed).length;

    return (
      <>
        <h1>{tenant.name}</h1>
        <p className="muted">
          Acting as <code>{tenant.slug}</code>. There is no login yet — one function decides this (
          <code>currentTenant</code>), so adding real authentication is a change in one place.
        </p>

        <div className="cards">
          <div className="card">
            <div className="muted">Spend</div>
            <div className="value">${spend.totalCostUsd.toFixed(4)}</div>
          </div>
          <div className="card">
            <div className="muted">Model calls</div>
            <div className="value">{spend.calls}</div>
          </div>
          <div className="card">
            <div className="muted">Tokens in / out</div>
            <div className="value">
              {spend.inputTokens} / {spend.outputTokens}
            </div>
          </div>
          <div className="card">
            <div className="muted">Recent turns that failed</div>
            <div className={failed > 0 ? 'value failed' : 'value'}>
              {failed} of {recent.length}
            </div>
          </div>
        </div>

        <h2>Recent turns</h2>
        {recent.length === 0 ? (
          <p className="muted">
            Nothing has run yet. Spend is recorded per call and traces per turn, so both fill in as
            soon as the agent answers something.
          </p>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Started</th>
                <th>Steps</th>
                <th>Ended as</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {recent.map((turn) => (
                <tr key={turn.traceId}>
                  <td>{turn.startedAt.toISOString().replace('T', ' ').slice(0, 19)}</td>
                  <td>{turn.steps}</td>
                  <td className={turn.failed ? 'failed' : undefined}>
                    {turn.endedAs ?? 'did not finish'}
                  </td>
                  <td>
                    <a href={`/traces/${turn.traceId}`}>open</a>
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
