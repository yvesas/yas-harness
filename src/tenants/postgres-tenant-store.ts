// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: tenants in PostgreSQL.
 *
 * The slug's shape is checked here *and* by a constraint on the table. The
 * duplication is deliberate: the check gives a caller a typed error naming the
 * rule, and the constraint means a row written by anything else — a migration,
 * a script, another service — still cannot break the rule.
 */

import type { Pool } from 'pg';

import type { CreateTenantInput, Tenant, TenantStore } from './tenant-store.js';
import { assertValidSlug } from './tenant-store.js';

interface TenantRow {
  id: string;
  slug: string;
  name: string;
  created_at: Date;
}

export class PostgresTenantStore implements TenantStore {
  constructor(private readonly pool: Pool) {}

  async create(input: CreateTenantInput): Promise<Tenant> {
    assertValidSlug(input.slug);
    const { rows } = await this.pool.query<TenantRow>(
      'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id, slug, name, created_at',
      [input.slug, input.name],
    );
    return toTenant(rows[0]!);
  }

  async ensure(input: CreateTenantInput): Promise<Tenant> {
    assertValidSlug(input.slug);
    // DO UPDATE rather than DO NOTHING: NOTHING returns no row on conflict,
    // which would make the common path a second round trip.
    const { rows } = await this.pool.query<TenantRow>(
      `INSERT INTO tenants (slug, name) VALUES ($1, $2)
         ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
       RETURNING id, slug, name, created_at`,
      [input.slug, input.name],
    );
    return toTenant(rows[0]!);
  }

  async find(id: string): Promise<Tenant | null> {
    const { rows } = await this.pool.query<TenantRow>(
      'SELECT id, slug, name, created_at FROM tenants WHERE id = $1',
      [id],
    );
    return rows[0] ? toTenant(rows[0]) : null;
  }

  async findBySlug(slug: string): Promise<Tenant | null> {
    const { rows } = await this.pool.query<TenantRow>(
      'SELECT id, slug, name, created_at FROM tenants WHERE slug = $1',
      [slug],
    );
    return rows[0] ? toTenant(rows[0]) : null;
  }

  async list(): Promise<Tenant[]> {
    const { rows } = await this.pool.query<TenantRow>(
      'SELECT id, slug, name, created_at FROM tenants ORDER BY created_at, slug',
    );
    return rows.map(toTenant);
  }

  async delete(id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM tenants WHERE id = $1', [id]);
    return (rowCount ?? 0) > 0;
  }
}

function toTenant(row: TenantRow): Tenant {
  return { id: row.id, slug: row.slug, name: row.name, createdAt: row.created_at };
}
