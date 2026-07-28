// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Port: scrub secrets out of free text before it is logged or persisted.
 *
 * This is *not* compression and *not* the sensitivity gate — it is the opposite
 * of both. Compression may drop text but never changes a value; the gate keeps
 * protected values byte-perfect. Redaction deliberately destroys a value: an
 * API key, a token, a private key, a password in a connection string has no
 * business reaching a log line or a database row, so it is replaced outright.
 *
 * It runs on the persistence and log path, always, and is never discardable —
 * unlike a compression engine, whose output the pipeline may throw away. Losing
 * a secret is the goal, not a risk to guard against.
 */
export interface SecretRedactor {
  /** Replace any secret-shaped substring in `text` with a placeholder. */
  redact(text: string): string;
}

/**
 * Redact every string leaf inside an arbitrary JSON-ish value, returning a new
 * value. Objects and arrays are walked; object keys are left alone (a key is a
 * field name, not a secret). Non-string, non-container leaves pass through.
 * This is how a `unknown` payload — a pool value, a tool-call input — is scrubbed
 * without the caller knowing its shape.
 */
export function redactDeep(redactor: SecretRedactor, value: unknown): unknown {
  if (typeof value === 'string') {
    return redactor.redact(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactDeep(redactor, item));
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = redactDeep(redactor, item);
    }
    return out;
  }
  return value;
}
