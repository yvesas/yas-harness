#!/usr/bin/env node
// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Make sure a tenant exists.
 *
 * Operational, not application code: any product on the harness needs a first
 * tenant before anything can be attributed to one, and the console needs one
 * before it will render at all.
 *
 * The console deliberately **fails** when its tenant is missing rather than
 * creating one: a console that mints the thing it is meant to be showing you
 * renders an empty dashboard that looks like a working one. That is right for a
 * page load and wrong for a first `docker compose up`, which should just work.
 *
 * So the creation happens here — a named step in the compose file that somebody
 * can read, disable, or run by hand. Explicit and greppable, rather than a
 * side effect hidden in a page.
 *
 * Idempotent: `ensure` returns the existing tenant if there is one.
 */

import pg from 'pg';

import { PostgresTenantStore } from '../dist/tenants/postgres-tenant-store.js';

const slug = process.env.TENANT_SLUG ?? 'console';
const name = process.env.TENANT_NAME ?? slug;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) {
  console.error('DATABASE_URL is not set');
  process.exit(1);
}

// The store on its own, not `createHarness`. Creating a tenant is a row in a
// table: it needs no persona, no model gateway and no connectors, and booting
// the whole composition to write it would drag their configuration in as a
// prerequisite for a schema operation.
const pool = new pg.Pool({ connectionString: databaseUrl });
try {
  const tenant = await new PostgresTenantStore(pool).ensure({ slug, name });
  console.log(`tenant ready  ${tenant.slug}  ${tenant.id}`);
} finally {
  await pool.end();
}
