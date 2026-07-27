// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The sensitivity gate — what compression may never change. Proves it finds the
 * value classes that must stay byte-perfect, and that `preservesSensitive`
 * accepts a whitespace-only edit but rejects any edit that drops or alters a
 * protected value.
 */

import { describe, expect, it } from 'vitest';

import { RegexSensitivityGuard } from '../../src/compression/sensitivity-gate.js';

const guard = new RegexSensitivityGuard();

describe('RegexSensitivityGuard — detection', () => {
  it('finds money, numbers, dates, uuids, urls, emails and code', () => {
    const text = [
      'The price is $1,234.56 due on 2026-08-01T10:00:00Z.',
      'Case 998877 for user ana@example.com at https://example.com/x?y=1 today.',
      'Id 550e8400-e29b-41d4-a716-446655440000.',
      'Run `npm test` in:',
      '```\nconst x = 1;\n```',
    ].join('\n');

    const tokens = guard.protectedTokens(text);

    expect(tokens).toContain('$1,234.56');
    expect(tokens).toContain('2026-08-01T10:00:00Z');
    expect(tokens).toContain('ana@example.com');
    expect(tokens).toContain('https://example.com/x?y=1');
    expect(tokens).toContain('550e8400-e29b-41d4-a716-446655440000');
    expect(tokens).toContain('`npm test`');
    expect(tokens).toContain('```\nconst x = 1;\n```');
  });
});

describe('RegexSensitivityGuard — preservesSensitive', () => {
  it('accepts an identical text', () => {
    expect(guard.preservesSensitive('pay $10.00 by 2026-08-01', 'pay $10.00 by 2026-08-01')).toBe(
      true,
    );
  });

  it('accepts a whitespace-only edit', () => {
    expect(guard.preservesSensitive('pay   $10.00   today', 'pay $10.00 today')).toBe(true);
  });

  it('accepts reordering when every protected value still appears', () => {
    expect(guard.preservesSensitive('$10.00 and $20.00', '$20.00 and $10.00')).toBe(true);
  });

  it('rejects dropping a protected value', () => {
    expect(guard.preservesSensitive('total $1,234.56 net', 'total net')).toBe(false);
  });

  it('rejects altering a money value', () => {
    expect(guard.preservesSensitive('total is $1,234.56', 'total is $1,235')).toBe(false);
  });

  it('rejects altering a date', () => {
    expect(guard.preservesSensitive('due 2026-08-01', 'due 2026-08-02')).toBe(false);
  });

  it('rejects removing one of a repeated value', () => {
    // "$10.00" appears twice before, once after.
    expect(guard.preservesSensitive('$10.00 then $10.00', 'just $10.00')).toBe(false);
  });
});
