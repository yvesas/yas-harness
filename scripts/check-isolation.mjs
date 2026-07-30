#!/usr/bin/env node
// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Enforces multi-tenant isolation in the schema itself.
 *
 * The harness claims isolation is "guaranteed by a constraint in the database,
 * not only by the application". Every table today honours that. The risk is not
 * the tables that exist — they have their own tests — it is the **next** one:
 * a table added without `tenant_id`, or with a foreign key that names a row
 * without also naming its tenant, would let one tenant's data attach to
 * another's, and every existing test would still pass.
 *
 * So this reads the migrations and refuses three specific mistakes:
 *
 * 1. A table holding user data with no `tenant_id`.
 * 2. A `tenant_id` that does not cascade from `tenants` — erasure is one
 *    `DELETE`, and a table that does not cascade silently outlives it.
 * 3. A foreign key to a tenant-scoped table that names only the row id. The
 *    composite `(id, tenant_id)` is what makes a cross-tenant reference
 *    impossible to *write*, rather than merely discouraged.
 *
 * Run it with `npm run isolation`.
 */

import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS = join(dirname(fileURLToPath(import.meta.url)), '..', 'migrations');

/**
 * Tables that legitimately carry no `tenant_id`, each with the reason. Adding
 * to this list is a deliberate act, which is the point of having it.
 */
const EXEMPT = new Map([
  ['tenants', 'it is the boundary itself'],
  ['schema_migrations', 'migration bookkeeping, created by the runner, holds no user data'],
]);

const violations = [];

const files = (await readdir(MIGRATIONS)).filter((name) => name.endsWith('.up.sql')).sort();

/** Tenant-scoped tables, so a later migration's foreign keys can be judged. */
const scoped = new Set();

for (const file of files) {
  const sql = await readFile(join(MIGRATIONS, file), 'utf8');

  for (const table of tablesIn(sql)) {
    if (EXEMPT.has(table.name)) {
      continue;
    }

    if (!/\btenant_id\b/.test(table.body)) {
      violations.push(
        `${file}: table "${table.name}" has no tenant_id.\n` +
          `    Every table holding user data carries one. If this one genuinely does not,\n` +
          `    add it to EXEMPT in this script with the reason.`,
      );
      continue;
    }
    scoped.add(table.name);

    // The tenant_id has to be anchored so that deleting a tenant reaches it —
    // erasure is one DELETE, and a table it cannot reach outlives the request
    // it was meant to honour. Two anchors are valid:
    //
    //   direct       tenant_id REFERENCES tenants (id) ON DELETE CASCADE
    //   transitive   FOREIGN KEY (x, tenant_id) REFERENCES scoped (id, tenant_id)
    //                  ON DELETE CASCADE
    //
    // The transitive one is the stronger of the two where it applies: because
    // the row's tenant travels in the same key as its parent, a child's tenant
    // cannot disagree with its parent's. A direct reference would allow exactly
    // that. So `messages` anchors through `sessions`, not through `tenants`.
    if (!anchoredToTenants(table.body) && !anchoredThroughScoped(table.body, scoped)) {
      violations.push(
        `${file}: "${table.name}".tenant_id is not anchored to a cascading delete.\n` +
          `    Either reference tenants (id) ON DELETE CASCADE directly, or carry the\n` +
          `    tenant in a composite foreign key to an already tenant-scoped table.\n` +
          `    Without one of the two, erasing a tenant leaves this table behind.`,
      );
    }

    for (const reference of referencesIn(table.body)) {
      if (reference.table === 'tenants' || !scoped.has(reference.table)) {
        continue;
      }
      if (!reference.columns.includes('tenant_id')) {
        violations.push(
          `${file}: "${table.name}" references ${reference.table} (${reference.columns.join(', ')})\n` +
            `    without the tenant. Use the composite key (id, tenant_id): it is what makes\n` +
            `    attaching one tenant's row to another's impossible to write.`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error('\nmulti-tenant isolation is not held by the schema:\n');
  for (const violation of violations) {
    console.error(`  ✗ ${violation}\n`);
  }
  process.exit(1);
}

console.log(
  `isolation holds: ${scoped.size} tenant-scoped tables, every cross-table key carries the tenant`,
);

/** `tenant_id uuid ... REFERENCES tenants (id) ON DELETE CASCADE` on the column. */
function anchoredToTenants(body) {
  const column = body.match(/tenant_id[^,]*?REFERENCES\s+tenants\s*\(\s*id\s*\)[^,]*/is);
  return column !== null && /ON\s+DELETE\s+CASCADE/i.test(column[0]);
}

/**
 * A composite foreign key that carries `tenant_id` into an already tenant-scoped
 * table, and cascades. `ON DELETE CASCADE` may sit on the following line, so the
 * clause is read to the end of the constraint rather than the end of the line.
 */
function anchoredThroughScoped(body, scoped) {
  const pattern =
    /FOREIGN\s+KEY\s*\(([^)]*)\)\s*REFERENCES\s+([a-z_]+)\s*\(([^)]*)\)([\s\S]{0,80})/gi;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    const carries = match[1].split(',').some((column) => column.trim() === 'tenant_id');
    if (carries && scoped.has(match[2]) && /ON\s+DELETE\s+CASCADE/i.test(match[4])) {
      return true;
    }
  }
  return false;
}

/** Each `CREATE TABLE name ( ... )` in a migration, with its body. */
function* tablesIn(sql) {
  const pattern = /CREATE\s+TABLE\s+(?:IF\s+NOT\s+EXISTS\s+)?([a-z_]+)\s*\(/gi;
  let match;
  while ((match = pattern.exec(sql)) !== null) {
    const body = balanced(sql, match.index + match[0].length - 1);
    yield { name: match[1], body };
  }
}

/** Each `REFERENCES other (cols)` inside a table body. */
function* referencesIn(body) {
  const pattern = /REFERENCES\s+([a-z_]+)\s*\(([^)]*)\)/gi;
  let match;
  while ((match = pattern.exec(body)) !== null) {
    yield {
      table: match[1],
      columns: match[2].split(',').map((column) => column.trim()),
    };
  }
}

/** The text between a `(` and its matching `)`, so nested parens do not truncate. */
function balanced(sql, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < sql.length; i += 1) {
    if (sql[i] === '(') depth += 1;
    else if (sql[i] === ')') {
      depth -= 1;
      if (depth === 0) return sql.slice(openIndex + 1, i);
    }
  }
  return sql.slice(openIndex + 1);
}
