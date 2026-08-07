// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Evals — is the cheap tier still getting it right?
 *
 * The router decides on the cheap model, which is what makes it cheap and what
 * makes it worth measuring. `docs` calls the router eval a required step rather
 * than a nicety: a cheap router is only trustworthy once its hit rate is known,
 * and the rate moves whenever the routes, the models or the modules change.
 *
 * This page is that measurement where somebody will actually look at it.
 */

import { harness } from '../../lib/harness';
import { Failure } from '../failure';
import { RouterEval } from './runner';

export const dynamic = 'force-dynamic';

export default async function Evals() {
  try {
    const modules = (await harness()).modules.list();

    return (
      <>
        <h1 className="text-2xl font-semibold tracking-tight">Evals</h1>
        <p className="text-muted-foreground text-sm">
          The router decides on the cheap tier — that is what makes it cheap, and what makes it
          worth measuring. Its hit rate moves whenever the routes, the models or the modules change,
          so it is a number to re-check rather than one to establish once.
        </p>

        <p className="text-muted-foreground text-sm">
          Registered right now: {modules.map((module) => module.id).join(', ') || 'nothing'}. A case
          expecting anything else will fail, which is usually the case being wrong rather than the
          router.
        </p>

        <RouterEval
          modules={modules.map((module) => ({ id: module.id, description: module.description }))}
        />

        <p className="text-muted-foreground text-sm">
          Cases are typed here rather than read from a file: they are a question somebody is asking
          now, and writing them to disk to answer it would turn an experiment into a commit. A set
          worth keeping belongs in the repository, next to the module it guards.
        </p>
      </>
    );
  } catch (error) {
    return <Failure error={error} />;
  }
}
