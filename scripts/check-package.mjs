#!/usr/bin/env node
// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Proves the harness is installable and importable — from the outside.
 *
 * A package manifest is the one part of a project that its own test suite never
 * exercises: every test imports `src/` by relative path, so a missing `exports`
 * entry, a file left out of `files`, or a broken build all pass CI and fail on
 * the first consumer. This packs the tarball, installs it into a throwaway
 * directory, and imports it the way a product would.
 *
 * Run it with `npm run package:check`.
 */

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** Everything a consumer must find in the tarball, and why. */
const REQUIRED = [
  ['package/dist/index.js', 'the entry point'],
  ['package/dist/index.d.ts', 'types, or a TypeScript consumer gets `any`'],
  ['package/migrations/0001_init.up.sql', 'the schema — a consumer has to create it'],
  ['package/scripts/migrate.mjs', 'the migration runner, or the migrations are unusable'],
  ['package/config/models.json', 'a starting configuration; the harness will not boot without one'],
  ['package/NOTICE', 'required to travel with the code by the Apache licence'],
];

/** Named exports a product is expected to reach for on day one. */
const EXPECTED_EXPORTS = [
  'createHarness',
  'Agent',
  'ToolRegistry',
  'ModuleRegistry',
  'ConnectionManager',
  'ScriptedGateway',
  'InMemoryTenantStore',
];

function run(command, args, options = {}) {
  return execFileSync(command, args, { encoding: 'utf8', ...options });
}

function fail(message) {
  console.error(`\n  ✗ ${message}\n`);
  process.exit(1);
}

console.log('  building…');
run('npm', ['run', 'build'], { cwd: ROOT, stdio: 'inherit' });

console.log('  packing…');
// --dry-run reports the contents without writing a tarball we would have to
// clean up; the real pack happens below, into the temp directory.
const [report] = JSON.parse(run('npm', ['pack', '--dry-run', '--json'], { cwd: ROOT }));
const shipped = new Set(report.files.map((file) => `package/${file.path}`));

for (const [path, why] of REQUIRED) {
  if (!shipped.has(path)) {
    fail(`${path} is not in the package — ${why}.\n    Check "files" in package.json.`);
  }
}

// The opposite mistake: shipping what should stay home.
for (const leaked of ['package/.env', 'package/src/index.ts', 'package/tests/smoke.test.js']) {
  if (shipped.has(leaked)) {
    fail(`${leaked} is in the package and should not be.`);
  }
}
console.log(`  ✓ ${report.files.length} files, ${(report.size / 1024).toFixed(0)}kB`);

const workspace = mkdtempSync(join(tmpdir(), 'yas-harness-pkg-'));
try {
  // The name comes from the report, not from the second pack's stdout: packing
  // runs `prepare`, whose build output lands on stdout too, so parsing it
  // yields the build log with a filename buried in it.
  run('npm', ['pack', '--pack-destination', workspace], { cwd: ROOT, stdio: 'ignore' });
  const tarball = report.filename;

  writeFileSync(
    join(workspace, 'package.json'),
    JSON.stringify({ name: 'consumer', private: true, type: 'module' }),
  );
  console.log('  installing into a throwaway project…');
  run('npm', ['install', '--no-audit', '--no-fund', join(workspace, tarball)], {
    cwd: workspace,
    stdio: 'ignore',
  });

  // Import it exactly as a product would: by package name, not by path.
  writeFileSync(
    join(workspace, 'probe.mjs'),
    `import * as harness from 'yas-harness';
     const missing = ${JSON.stringify(EXPECTED_EXPORTS)}.filter((name) => !(name in harness));
     if (missing.length > 0) {
       console.error('missing exports: ' + missing.join(', '));
       process.exit(1);
     }
     console.log('  ✓ imported by name, ' + Object.keys(harness).length + ' exports');
    `,
  );
  try {
    run('node', ['probe.mjs'], { cwd: workspace, stdio: 'inherit' });
  } catch {
    // The probe already said what was missing; a Node stack on top of it only
    // buries the one line that matters.
    fail('the package does not import cleanly (see above).');
  }
} finally {
  rmSync(workspace, { recursive: true, force: true });
}

console.log('\n  the package installs and imports cleanly.\n');
