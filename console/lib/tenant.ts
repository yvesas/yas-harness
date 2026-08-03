// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Who the console is acting as.
 *
 * There is no login yet, and there is still exactly **one** function that
 * answers this. Every page and every action goes through it, so the day real
 * authentication arrives it is this function that changes — not forty files
 * that each read a tenant id from somewhere slightly different. Today that
 * costs nothing; skipping it would cost a search-and-replace across a codebase
 * where one missed call is a cross-tenant read.
 *
 * The tenant is named by slug rather than id, because a slug is a thing a human
 * can put in an env file and recognise later.
 */

import { harness } from './harness';

const DEFAULT_SLUG = 'console';

export class NoTenantError extends Error {
  constructor(slug: string) {
    super(
      `no tenant with the slug "${slug}". Create it once with the harness's TenantStore, ` +
        'or point CONSOLE_TENANT_SLUG at one that exists.',
    );
    this.name = 'NoTenantError';
  }
}

/**
 * The tenant every read on this request belongs to.
 *
 * It **fails** when the tenant does not exist rather than creating it. A
 * console that mints a tenant on first page load would quietly manufacture the
 * thing it was meant to be showing you, and the empty dashboard would look like
 * a working one.
 */
export async function currentTenant(): Promise<{ id: string; slug: string; name: string }> {
  const slug = process.env['CONSOLE_TENANT_SLUG'] ?? DEFAULT_SLUG;
  const found = await (await harness()).tenants.findBySlug(slug);
  if (!found) {
    throw new NoTenantError(slug);
  }
  return { id: found.id, slug: found.slug, name: found.name };
}
