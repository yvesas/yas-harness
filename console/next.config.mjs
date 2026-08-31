// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Built to run beside the database it reads, not on somebody's edge.
 *
 * `standalone` emits a self-contained server the harness's own compose file can
 * run — which is the point: the console holds the master key and talks to
 * Postgres directly, so hosting it on a managed platform would mean shipping
 * that key off the machine.
 */
/** @type {import('next').NextConfig} */
export default {
  output: 'standalone',
  // The harness is a workspace dependency compiled to ESM; nothing here needs
  // it bundled, and tracing it keeps `standalone` honest about what it needs.
  outputFileTracingRoot: new URL('..', import.meta.url).pathname,
  // Stable since Next 16.3; it lived under `experimental` until then.
  typedRoutes: true,
};
