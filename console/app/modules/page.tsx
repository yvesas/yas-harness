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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';

export const dynamic = 'force-dynamic';

export default async function Modules() {
  try {
    const modules = (await harness()).modules.list();

    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Modules</h1>
        <p className="text-muted-foreground text-sm">
          Two demonstration modules, and two is the minimum that means anything: the router
          short-circuits with one candidate, and a context request needs somebody to ask somebody
          else.
        </p>
        {modules.map((module) => (
          <section key={module.id}>
            <h2 className="mt-8 text-lg font-semibold tracking-tight">
              <code>{module.id}</code>
            </h2>
            <p>{module.description}</p>
            <p className="text-muted-foreground text-sm">
              {module.disclose
                ? 'Declares disclose — it decides, per request, what to reveal.'
                : 'Declares no disclose, so it shares nothing. The broker fails closed.'}
            </p>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Tool</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead>Approval</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {module.tools.list().map((tool) => (
                  <TableRow key={tool.name}>
                    <TableCell>
                      <code>{tool.name}</code>
                    </TableCell>
                    <TableCell>{tool.description}</TableCell>
                    <TableCell>{tool.requiresApproval ? 'required' : 'not required'}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </section>
        ))}
      </>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
