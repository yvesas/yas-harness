// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Port: the isolation boundary itself.
 *
 * Every other table in the harness carries a `tenant_id` and every other port
 * takes one as its first argument — and until now there was no way to make one.
 * A product's very first action had no API, so it wrote the row itself. That is
 * the kind of gap only building something on the harness finds.
 *
 * The harness does not model who a tenant *is* — a person, a company, a
 * workspace is the product's question. It models that the boundary exists, has
 * a stable id, and can be created, found and erased.
 */

export interface Tenant {
  readonly id: string;
  /** Stable, human-readable handle: lowercase, digits, dashes. */
  readonly slug: string;
  readonly name: string;
  readonly createdAt: Date;
}

export interface CreateTenantInput {
  readonly slug: string;
  readonly name: string;
}

/** Slugs a tenant may use — the same shape the database constraint enforces. */
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

export class TenantError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'TenantError';
  }
}

export function assertValidSlug(slug: string): void {
  if (!SLUG.test(slug)) {
    throw new TenantError(`tenant slug must match ${SLUG.source}; got ${JSON.stringify(slug)}`);
  }
}

export interface TenantStore {
  create(input: CreateTenantInput): Promise<Tenant>;
  /**
   * Create the tenant, or return the one that already holds the slug.
   *
   * The first call of any deployment, and of every example and test — without
   * it each of them writes its own upsert, which is exactly what this port
   * exists to stop.
   */
  ensure(input: CreateTenantInput): Promise<Tenant>;
  find(id: string): Promise<Tenant | null>;
  findBySlug(slug: string): Promise<Tenant | null>;
  list(): Promise<Tenant[]>;
  /**
   * Erase a tenant and everything that belongs to it.
   *
   * Every user-data table cascades from here, so this is one call, and it is
   * the mechanism behind a deletion request — a right the harness has to be
   * able to honour rather than describe. Returns false if there was nothing to
   * erase.
   */
  delete(id: string): Promise<boolean>;
}
