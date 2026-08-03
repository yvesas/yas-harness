// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * What is registered, and what each module is willing to share.
 *
 * The `disclose` column is the one worth reading. A module that declares no
 * discloser shares nothing — the broker fails closed — and seeing that stated
 * as a fact rather than as a blank is the difference between a decision and an
 * oversight.
 */

import { harness } from '../../lib/harness';
import { Failure } from '../failure';

export const dynamic = 'force-dynamic';

export default async function Modules() {
  try {
    const modules = (await harness()).modules.list();

    return (
      <>
        <h1>Modules</h1>
        <p className="muted">
          Two demonstration modules, and two is the minimum that means anything: the router
          short-circuits with one candidate, and a context request needs somebody to ask somebody
          else.
        </p>
        {modules.map((module) => (
          <section key={module.id}>
            <h2>
              <code>{module.id}</code>
            </h2>
            <p>{module.description}</p>
            <p className="muted">
              {module.disclose
                ? 'Declares disclose — it decides, per request, what to reveal.'
                : 'Declares no disclose, so it shares nothing. The broker fails closed.'}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Tool</th>
                  <th>Description</th>
                  <th>Approval</th>
                </tr>
              </thead>
              <tbody>
                {module.tools.list().map((tool) => (
                  <tr key={tool.name}>
                    <td>
                      <code>{tool.name}</code>
                    </td>
                    <td>{tool.description}</td>
                    <td>{tool.requiresApproval ? 'required' : 'not required'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
      </>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
