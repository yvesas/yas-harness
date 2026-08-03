// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * One turn, step by step: input → route → model → tools → end.
 *
 * A flat ordered list, because that is what a trace is. Rendering it as a tree
 * would mean inventing a nesting the recorder deliberately does not claim.
 *
 * Nothing is redacted here. It does not need to be: `detail` and `errorMessage`
 * went through the redactor on the way *in*, so what is stored is already
 * scrubbed — and re-scrubbing on read would hide the difference between "the
 * secret was caught" and "the display is hiding it".
 */

import { currentTenant } from '../../../lib/tenant';
import { harness } from '../../../lib/harness';
import { Failure } from '../../failure';

export const dynamic = 'force-dynamic';

export default async function Trace({ params }: { params: Promise<{ traceId: string }> }) {
  try {
    const { traceId } = await params;
    const tenant = await currentTenant();
    const steps = await (await harness()).traceReader.trace(tenant.id, traceId);

    if (steps.length === 0) {
      return (
        <>
          <h1>Turn not found</h1>
          <p className="muted">
            No steps under <code>{traceId}</code> for this tenant. A trace is scoped to its tenant,
            so this is also what another tenant&rsquo;s turn looks like from here.
          </p>
        </>
      );
    }

    const total = steps.reduce((sum, step) => sum + (step.durationMs ?? 0), 0);

    return (
      <>
        <h1>Turn</h1>
        <p className="muted">
          <code>{traceId}</code> · {steps.length} steps · {total}ms of measured work
        </p>
        <table>
          <thead>
            <tr>
              <th>#</th>
              <th>Step</th>
              <th>What</th>
              <th>Took</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((step) => (
              <tr key={step.sequence}>
                <td className="muted">{step.sequence}</td>
                <td className={step.succeeded ? undefined : 'failed'}>{step.kind}</td>
                <td>
                  <code>{step.label ?? '—'}</code>
                </td>
                <td>{step.durationMs === undefined ? '—' : `${step.durationMs}ms`}</td>
                <td>
                  {step.errorMessage ? <div className="failed">{step.errorMessage}</div> : null}
                  {step.detail ? (
                    <code className="muted">{JSON.stringify(step.detail)}</code>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="muted">
          Measured work is the sum of the steps that reported a duration, not wall-clock for the
          turn — a step that never returned reports nothing.
        </p>
      </>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
