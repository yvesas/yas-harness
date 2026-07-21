#!/usr/bin/env node
// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Apache 2.0 asks contributors to mark the files they own. This checks that
 * every source file carries the copyright and SPDX header.
 *
 *   node scripts/check-license-headers.mjs         report missing headers
 *   node scripts/check-license-headers.mjs --fix   insert them
 */

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const IGNORED_DIRS = new Set(['node_modules', 'dist', 'coverage', '.git']);
const CHECKED_EXTENSIONS = new Set(['.ts', '.js', '.mjs', '.sql']);

const COPYRIGHT = 'Copyright 2026 YAS Softwares LTDA';
const SPDX = 'SPDX-License-Identifier: Apache-2.0';

function commentPrefix(file) {
  return extname(file) === '.sql' ? '--' : '//';
}

async function* sourceFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.githooks') continue;
    if (IGNORED_DIRS.has(entry.name)) continue;

    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(full);
    } else if (CHECKED_EXTENSIONS.has(extname(entry.name))) {
      yield full;
    }
  }
}

function hasHeader(content) {
  const head = content.slice(0, 500);
  return head.includes(COPYRIGHT) && head.includes(SPDX);
}

function withHeader(file, content) {
  const prefix = commentPrefix(file);
  const header = `${prefix} ${COPYRIGHT}\n${prefix} ${SPDX}\n\n`;

  // Keep a shebang on the first line.
  if (content.startsWith('#!')) {
    const newline = content.indexOf('\n') + 1;
    return content.slice(0, newline) + header + content.slice(newline);
  }
  return header + content;
}

const fix = process.argv.includes('--fix');
const missing = [];

for await (const file of sourceFiles(ROOT)) {
  const content = await readFile(file, 'utf8');
  if (hasHeader(content)) continue;

  if (fix) {
    await writeFile(file, withHeader(file, content));
    console.log(`added header  ${relative(ROOT, file)}`);
  } else {
    missing.push(relative(ROOT, file));
  }
}

if (missing.length > 0) {
  console.error('Missing license header:\n');
  for (const file of missing) console.error(`  ${file}`);
  console.error('\nRun: npm run license:fix');
  process.exit(1);
}

if (!fix) console.log('all source files carry the license header');
