#!/usr/bin/env node
// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Migration runner.
 *
 * Plain ESM so it runs identically from source and from the Docker image,
 * without a build step or a dev dependency.
 *
 *   node scripts/migrate.mjs status
 *   node scripts/migrate.mjs up          apply every pending migration
 *   node scripts/migrate.mjs down        roll back the last applied migration
 *
 * Migrations live in migrations/ as pairs:
 *   0001_name.up.sql   and   0001_name.down.sql
 * Every migration is reversible; a missing .down.sql is an error, not a choice.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import pg from 'pg';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');
// Guards against two processes migrating the same database at once.
const ADVISORY_LOCK_KEY = 4_732_119;

async function loadMigrations() {
  const entries = await readdir(MIGRATIONS_DIR);
  const migrations = new Map();

  for (const file of entries) {
    const match = /^(\d+)_(.+)\.(up|down)\.sql$/.exec(file);
    if (!match) continue;

    const [, version, name, direction] = match;
    const migration = migrations.get(version) ?? { version, name };
    migration[direction] = join(MIGRATIONS_DIR, file);
    migrations.set(version, migration);
  }

  const sorted = [...migrations.values()].sort((a, b) => a.version.localeCompare(b.version));

  for (const migration of sorted) {
    if (!migration.up) throw new Error(`migration ${migration.version} has no .up.sql`);
    if (!migration.down) throw new Error(`migration ${migration.version} has no .down.sql`);
  }

  return sorted;
}

async function ensureMigrationsTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text        PRIMARY KEY,
      name       text        NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);
}

async function appliedVersions(client) {
  const { rows } = await client.query('SELECT version FROM schema_migrations ORDER BY version');
  return new Set(rows.map((row) => row.version));
}

async function runMigration(client, migration, direction) {
  const sql = await readFile(migration[direction], 'utf8');

  await client.query('BEGIN');
  try {
    await client.query(sql);
    if (direction === 'up') {
      await client.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [
        migration.version,
        migration.name,
      ]);
    } else {
      await client.query('DELETE FROM schema_migrations WHERE version = $1', [migration.version]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw new Error(`migration ${migration.version} (${direction}) failed: ${error.message}`, {
      cause: error,
    });
  }

  console.log(
    `${direction === 'up' ? 'applied' : 'reverted'}  ${migration.version}_${migration.name}`,
  );
}

async function commandStatus(client, migrations) {
  const applied = await appliedVersions(client);
  if (migrations.length === 0) {
    console.log('no migrations found');
    return;
  }
  for (const migration of migrations) {
    const mark = applied.has(migration.version) ? '[applied]' : '[pending]';
    console.log(`${mark} ${migration.version}_${migration.name}`);
  }
}

async function commandUp(client, migrations) {
  const applied = await appliedVersions(client);
  const pending = migrations.filter((migration) => !applied.has(migration.version));

  if (pending.length === 0) {
    console.log('database is up to date');
    return;
  }

  for (const migration of pending) {
    await runMigration(client, migration, 'up');
  }
}

async function commandDown(client, migrations) {
  const applied = await appliedVersions(client);
  const last = [...migrations].reverse().find((migration) => applied.has(migration.version));

  if (!last) {
    console.log('nothing to roll back');
    return;
  }

  await runMigration(client, last, 'down');
}

async function main() {
  const command = process.argv[2] ?? 'status';
  const commands = { status: commandStatus, up: commandUp, down: commandDown };

  if (!(command in commands)) {
    console.error(`unknown command: ${command}. Use status, up or down.`);
    process.exit(1);
  }

  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) {
    console.error(
      'DATABASE_URL is not set. Copy .env.example to .env and run with --env-file=.env',
    );
    process.exit(1);
  }

  const migrations = await loadMigrations();
  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query('SELECT pg_advisory_lock($1)', [ADVISORY_LOCK_KEY]);
    await ensureMigrationsTable(client);
    await commands[command](client, migrations);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [ADVISORY_LOCK_KEY]).catch(() => {});
    await client.end();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
