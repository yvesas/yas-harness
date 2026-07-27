// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The sensitivity gate: what compression must never change.
 *
 * Some values are worthless approximated — a price, a date or deadline, an id
 * or case number, a URL, an email, and anything inside code or a fenced block.
 * The gate finds those in a text and checks that a compressed version still
 * carries every one of them, byte for byte. The pipeline runs an engine only if
 * the gate agrees; so an engine can shrink prose, whitespace or boilerplate,
 * but a transform that would alter an exact value is caught and thrown away.
 *
 * This is the piece the OmniRoute study flagged as missing: a domain-agnostic
 * guarantee that lossy compression never touches what must stay exact.
 *
 * The patterns are all linear (no nested quantifiers, no ambiguous alternation)
 * so a hostile input cannot make the gate itself run slow.
 */

export interface SensitivityGuard {
  /** True if every protected value in `before` still appears (as often) in `after`. */
  preservesSensitive(before: string, after: string): boolean;
  /** The protected values found in a text — exposed for inspection and tests. */
  protectedTokens(text: string): string[];
}

// Each pattern captures a whole atomic value. Order does not matter: the tokens
// from every pattern are pooled into one multiset.
const PATTERNS: readonly RegExp[] = [
  // Fenced code blocks and inline code — whitespace and every character exact.
  /```[\s\S]*?```/g,
  /`[^`]*`/g,
  // URLs and emails.
  /https?:\/\/[^\s)"'<>]+/g,
  /[^\s@]+@[^\s@]+\.[^\s@]+/g,
  // UUIDs.
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
  // ISO dates and date-times.
  /\d{4}-\d{2}-\d{2}(?:[T ][0-9:.+-]*Z?)?/g,
  // Money: a currency mark then a number.
  /[$€£R]\s?\d[\d.,]*/g,
  // Any numeric literal (with thousands/decimal separators).
  /\d[\d.,]*/g,
];

export class RegexSensitivityGuard implements SensitivityGuard {
  preservesSensitive(before: string, after: string): boolean {
    const wanted = counts(this.protectedTokens(before));
    const have = counts(this.protectedTokens(after));
    for (const [token, need] of wanted) {
      if ((have.get(token) ?? 0) < need) {
        return false;
      }
    }
    return true;
  }

  protectedTokens(text: string): string[] {
    const tokens: string[] = [];
    for (const pattern of PATTERNS) {
      // A fresh matcher per call keeps the shared `lastIndex` from leaking.
      for (const match of text.matchAll(new RegExp(pattern.source, pattern.flags))) {
        tokens.push(match[0]);
      }
    }
    return tokens;
  }
}

function counts(tokens: readonly string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const token of tokens) {
    map.set(token, (map.get(token) ?? 0) + 1);
  }
  return map;
}
