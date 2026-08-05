// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The harness, once per process.
 *
 * `createHarness` opens a connection pool, so building one per request would
 * exhaust Postgres in a few page loads. It is cached on `globalThis` rather
 * than in a module variable because Next reloads modules in development, and a
 * module-scoped cache would leak a pool on every save.
 *
 * Note what this file imports: **`yas-harness`, by package name** — not a
 * relative path into `../src`. That is deliberate. It makes the console a
 * consumer of the published package like anyone else, so a missing export shows
 * up here as a build failure rather than as a surprise for the first person who
 * installs it.
 */

import { createHarness, type Harness, type PoolStore } from 'yas-harness';

import { buildModules } from '../modules/registry';

const CACHE = Symbol.for('yas-console.harness');

interface CacheHolder {
  [CACHE]?: Promise<Harness>;
}

export function harness(): Promise<Harness> {
  const holder = globalThis as CacheHolder;
  // The *promise* is cached, not the result: two requests during a cold start
  // would otherwise each open their own pool.
  // `configDir` is named rather than left to `process.cwd()`. Next's standalone
  // server runs from its own directory, so the default would look for the
  // harness's config inside the console's folder — which is how this failed the
  // first time it ran in a container.
  const { modules, tools } = buildModules(poolStore);
  holder[CACHE] ??= createHarness({
    modules,
    // The agent is handed the same tool objects the modules declare. The
    // harness keeps the two registries apart on purpose — a product may want
    // the agent to run less than a module advertises — and this product wants
    // them identical, so the page cannot show one thing and the agent run
    // another.
    tools,
    ...(process.env['CONFIG_DIR'] === undefined ? {} : { configDir: process.env['CONFIG_DIR'] }),
  });
  return holder[CACHE];
}

/**
 * The pool store, for the demonstration modules.
 *
 * Passed as a thunk so a module never holds a handle to a harness that is still
 * being built — the modules are registered *during* `createHarness`, so
 * resolving this eagerly would be a cycle.
 */
async function poolStore(): Promise<PoolStore> {
  return (await harness()).pools;
}
