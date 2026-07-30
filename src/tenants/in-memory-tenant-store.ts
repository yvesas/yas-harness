// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * For tests and for running without a database.
 *
 * It enforces the same slug rule and the same uniqueness as the table, so code
 * that passes against this one does not meet a new failure the first time it
 * meets Postgres.
 */

import { randomUUID } from 'node:crypto';

import type { CreateTenantInput, Tenant, TenantStore } from './tenant-store.js';
import { TenantError, assertValidSlug } from './tenant-store.js';

export class InMemoryTenantStore implements TenantStore {
  readonly #tenants = new Map<string, Tenant>();

  create(input: CreateTenantInput): Promise<Tenant> {
    assertValidSlug(input.slug);
    if ([...this.#tenants.values()].some((tenant) => tenant.slug === input.slug)) {
      throw new TenantError(`tenant slug "${input.slug}" is already taken`);
    }
    const tenant: Tenant = {
      id: randomUUID(),
      slug: input.slug,
      name: input.name,
      createdAt: new Date(),
    };
    this.#tenants.set(tenant.id, tenant);
    return Promise.resolve(tenant);
  }

  ensure(input: CreateTenantInput): Promise<Tenant> {
    assertValidSlug(input.slug);
    const existing = [...this.#tenants.values()].find((tenant) => tenant.slug === input.slug);
    if (!existing) {
      return this.create(input);
    }
    const updated: Tenant = { ...existing, name: input.name };
    this.#tenants.set(updated.id, updated);
    return Promise.resolve(updated);
  }

  find(id: string): Promise<Tenant | null> {
    return Promise.resolve(this.#tenants.get(id) ?? null);
  }

  findBySlug(slug: string): Promise<Tenant | null> {
    return Promise.resolve(
      [...this.#tenants.values()].find((tenant) => tenant.slug === slug) ?? null,
    );
  }

  list(): Promise<Tenant[]> {
    return Promise.resolve(
      [...this.#tenants.values()].sort(
        (a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.slug.localeCompare(b.slug),
      ),
    );
  }

  delete(id: string): Promise<boolean> {
    return Promise.resolve(this.#tenants.delete(id));
  }
}
