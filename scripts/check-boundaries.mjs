#!/usr/bin/env node
// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Enforces the two boundaries the architecture rests on (ADR 0001).
 *
 * Both fail quietly if left to code review: the code still compiles and the
 * tests still pass, and the damage only shows up when someone tries to swap a
 * provider or build a product on top.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'src');

/**
 * 1. The core depends on ports, never on implementations. An adapter import
 *    inside core/ means the loop can no longer run without that provider.
 */
const CORE_FORBIDDEN = [
  { pattern: /from\s+['"]pg['"]/, why: 'the core must not talk to a database driver' },
  {
    pattern: /from\s+['"]@anthropic-ai\/sdk['"]/,
    why: 'the core must not talk to a model provider SDK',
  },
  {
    // Any *-gateway.js except the port itself, model-gateway.js.
    pattern: /from\s+['"][^'"]*(?<!\/model)-gateway\.js['"]/,
    why: 'the core imports the ModelGateway port, not a gateway adapter',
  },
  {
    pattern: /from\s+['"].*-session-store\.js['"]/,
    why: 'the core imports the SessionStore port, not a store adapter',
  },
];

/**
 * 2. The golden rule: no product domain anywhere in the harness. These words
 *    belong to modules, which live in the products that fork this repo.
 */
const DOMAIN_WORDS = [
  'customer',
  'invoice',
  'expense',
  'vocabulary',
  'appointment',
  'lead',
  'campaign',
];

// Prose may name these words to explain the rule; code may not.
const CODE_LINE = /^\s*(?!\/\/|\*|\/\*)\S/;

const violations = [];

for await (const file of sourceFiles(SRC)) {
  const path = relative(ROOT, file);
  const content = await readFile(file, 'utf8');

  if (path.startsWith('src/core/')) {
    for (const { pattern, why } of CORE_FORBIDDEN) {
      if (pattern.test(content)) {
        violations.push(`${path}: ${why}`);
      }
    }
  }

  content.split('\n').forEach((line, index) => {
    if (!CODE_LINE.test(line)) return;
    for (const word of DOMAIN_WORDS) {
      if (new RegExp(`\\b${word}s?\\b`, 'i').test(line)) {
        violations.push(
          `${path}:${index + 1}: "${word}" is product domain — it belongs in a module, not the harness`,
        );
      }
    }
  });
}

if (violations.length > 0) {
  console.error('Boundary violations:\n');
  for (const violation of violations) console.error(`  ${violation}`);
  console.error('\nSee CLAUDE.md (golden rule) and docs/adr/0001-hexagonal-architecture.md');
  process.exit(1);
}

console.log('boundaries hold: core depends on ports, no product domain in src/');

async function* sourceFiles(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      yield* sourceFiles(full);
    } else if (entry.name.endsWith('.ts')) {
      yield full;
    }
  }
}
