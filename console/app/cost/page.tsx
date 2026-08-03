// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * What the tenant has spent.
 *
 * And an honest note about what it cannot yet show. `UsageReader.spend` returns
 * one aggregate — a total, a call count, tokens — with no breakdown by model or
 * by day. Doc 21 predicted this exact gap and asked the page to *ask* for it
 * rather than the harness to guess: so the page states the limit instead of
 * quietly rendering the only number it has as though it were the whole story.
 *
 * That missing breakdown is F6.6, and this page is the reason it is now a
 * concrete request rather than a vague plan item.
 */

import { currentTenant } from '../../lib/tenant';
import { harness } from '../../lib/harness';
import { Failure } from '../failure';

export const dynamic = 'force-dynamic';

export default async function Cost() {
  try {
    const tenant = await currentTenant();
    const spend = await (await harness()).usage.spend(tenant.id);

    return (
      <>
        <h1>Cost</h1>
        <div className="cards">
          <div className="card">
            <div className="muted">Total</div>
            <div className="value">${spend.totalCostUsd.toFixed(6)}</div>
          </div>
          <div className="card">
            <div className="muted">Calls</div>
            <div className="value">{spend.calls}</div>
          </div>
          <div className="card">
            <div className="muted">Input tokens</div>
            <div className="value">{spend.inputTokens}</div>
          </div>
          <div className="card">
            <div className="muted">Output tokens</div>
            <div className="value">{spend.outputTokens}</div>
          </div>
        </div>

        <h2>What this page cannot show yet</h2>
        <p className="muted">
          Cost per model, per day and per session, and the saving compression paid for. The harness
          records all of it — <code>model_usage</code> has the columns — but{' '}
          <code>UsageReader</code> only exposes the aggregate above.
        </p>
        <p className="muted">
          Left as a gap on purpose. A port added because a page might one day want it is a port
          shaped by a guess; this page asking for it is the request that should shape it. It is{' '}
          <strong>F6.6</strong>, and it is now concrete.
        </p>
      </>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
