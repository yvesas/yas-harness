// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The connection layer against a real database.
 *
 * The guarantees that matter here are security ones, so they are proven end to
 * end against the schema: the credential column never holds a plaintext
 * secret, a credential cannot outlive or cross into another tenant, and the
 * vault resolves what a previous process sealed.
 */

import { randomBytes } from 'node:crypto';

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { CredentialVault } from '../../src/connections/credential-vault.js';
import { EnvelopeCipher } from '../../src/connections/envelope-cipher.js';
import {
  PostgresConnectionStore,
  PostgresCredentialStore,
  PostgresTenantKeyStore,
} from '../../src/connections/postgres-connection-store.js';

const DATABASE_URL = process.env['DATABASE_URL'];

describe.skipIf(!DATABASE_URL)('connection layer (Postgres)', () => {
  let pool: pg.Pool;
  let connections: PostgresConnectionStore;
  let keys: PostgresTenantKeyStore;
  let credentials: PostgresCredentialStore;
  const cipher = new EnvelopeCipher(randomBytes(32));
  let tenantA: string;
  let tenantB: string;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    connections = new PostgresConnectionStore(pool);
    keys = new PostgresTenantKeyStore(pool);
    credentials = new PostgresCredentialStore(pool);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['conn-%']);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['conn-%']);
    tenantA = await createTenant(pool, 'conn-a');
    tenantB = await createTenant(pool, 'conn-b');
  });

  function vault(): CredentialVault {
    return new CredentialVault(cipher, keys, credentials);
  }

  describe('connection registry', () => {
    it('round-trips a connection', async () => {
      const created = await connections.create({
        tenantId: tenantA,
        connectorId: 'confluence',
        accountLabel: 'B81 space',
        scopes: ['read', 'write'],
      });

      expect(await connections.find(tenantA, created.id)).toEqual(created);
    });

    it('rejects a connector id the schema forbids', async () => {
      await expect(
        connections.create({ tenantId: tenantA, connectorId: 'Bad Connector' }),
      ).rejects.toThrow(/connections_connector_id_format/);
    });

    it('does not reveal another tenant’s connection', async () => {
      const created = await connections.create({ tenantId: tenantA, connectorId: 'notion' });

      expect(await connections.find(tenantB, created.id)).toBeNull();
    });
  });

  describe('credential vault', () => {
    it('stores the secret only as sealed bytes', async () => {
      const connection = await connections.create({ tenantId: tenantA, connectorId: 'confluence' });
      await vault().store(tenantA, connection.id, { accessToken: 'plaintext-token-value' });

      // Read the raw column: it must not contain the token in any encoding.
      const { rows } = await pool.query<{ sealed_secret: Buffer }>(
        'SELECT sealed_secret FROM credentials WHERE connection_id = $1',
        [connection.id],
      );
      const raw = rows[0]!.sealed_secret;
      expect(raw.toString('utf8')).not.toContain('plaintext-token-value');
      expect(raw.toString('latin1')).not.toContain('plaintext-token-value');
    });

    it('resolves what was sealed, across a fresh vault (a restart)', async () => {
      const connection = await connections.create({ tenantId: tenantA, connectorId: 'confluence' });
      await vault().store(tenantA, connection.id, { accessToken: 'abc', refreshToken: 'def' });

      // A brand-new vault, empty DEK cache, same cipher and tables.
      expect(await vault().resolve(tenantA, connection.id)).toEqual({
        accessToken: 'abc',
        refreshToken: 'def',
      });
    });

    it('gives each tenant a distinct data key', async () => {
      const a = await connections.create({ tenantId: tenantA, connectorId: 'drive' });
      const b = await connections.create({ tenantId: tenantB, connectorId: 'drive' });
      await vault().store(tenantA, a.id, { t: 'a' });
      await vault().store(tenantB, b.id, { t: 'b' });

      expect(await keys.find(tenantA)).not.toEqual(await keys.find(tenantB));
    });

    it('refuses to attach a credential to another tenant’s connection', async () => {
      const connection = await connections.create({ tenantId: tenantA, connectorId: 'confluence' });

      // The composite foreign key blocks it at the database.
      await expect(vault().store(tenantB, connection.id, { t: 'x' })).rejects.toThrow(
        /credentials_connection_fkey/,
      );
    });

    it('deletes the credential when its connection is removed', async () => {
      const connection = await connections.create({ tenantId: tenantA, connectorId: 'confluence' });
      await vault().store(tenantA, connection.id, { t: 'x' });

      await connections.remove(tenantA, connection.id);

      expect(await vault().resolve(tenantA, connection.id)).toBeNull();
    });

    it('drops keys and credentials when the tenant is deleted', async () => {
      const connection = await connections.create({ tenantId: tenantA, connectorId: 'confluence' });
      await vault().store(tenantA, connection.id, { t: 'x' });

      await pool.query('DELETE FROM tenants WHERE id = $1', [tenantA]);

      const keyCount = await countWhere(pool, 'tenant_keys', 'tenant_id', tenantA);
      const credCount = await countWhere(pool, 'credentials', 'tenant_id', tenantA);
      expect([keyCount, credCount]).toEqual(['0', '0']);
    });

    it('shares one data key across a tenant’s connections', async () => {
      const c1 = await connections.create({ tenantId: tenantA, connectorId: 'drive' });
      const c2 = await connections.create({ tenantId: tenantA, connectorId: 'notion' });
      await vault().store(tenantA, c1.id, { t: '1' });
      await vault().store(tenantA, c2.id, { t: '2' });

      const { rows } = await pool.query<{ count: string }>(
        'SELECT count(*)::text AS count FROM tenant_keys WHERE tenant_id = $1',
        [tenantA],
      );
      expect(rows[0]?.count).toBe('1');
    });
  });
});

async function createTenant(pool: pg.Pool, slug: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
    [slug, slug],
  );
  return rows[0]!.id;
}

async function countWhere(
  pool: pg.Pool,
  table: string,
  column: string,
  value: string,
): Promise<string> {
  // table and column are test-controlled literals, never user input.
  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM ${table} WHERE ${column} = $1`,
    [value],
  );
  return rows[0]!.count;
}
