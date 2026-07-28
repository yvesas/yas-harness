// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The default redactor: a set of rules for well-known secret shapes. It is
 * deliberately shape-based, not entropy-based — a rule fires only on something
 * that clearly is a credential (a provider key prefix, a JWT, a PEM block, a
 * labelled `password=`), so ordinary prose, numbers and ids are left intact.
 * The point is zero false negatives on the credentials that actually leak, with
 * few enough false positives that a redacted log is still readable.
 *
 * Every pattern is linear — flat alternations of literals and single character
 * classes, no nested quantifiers — so a hostile input cannot make redaction
 * itself run slow.
 */

import type { SecretRedactor } from './secret-redactor.js';

const PLACEHOLDER = '[REDACTED]';

interface RedactionRule {
  readonly pattern: RegExp;
  /** `$1`, `$2`… may keep structure (a key name, a URL scheme) around the cut. */
  readonly replacement: string;
}

// Order matters only where one shape can sit inside another (a JWT inside a
// `token=…`): the more specific shape runs first, and re-redacting a
// placeholder is harmless.
const RULES: readonly RedactionRule[] = [
  // PEM private key blocks (any key type).
  {
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: PLACEHOLDER,
  },
  // JWTs: header.payload.signature, each a base64url segment.
  {
    pattern: /\beyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
    replacement: PLACEHOLDER,
  },
  // AWS access key ids.
  { pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, replacement: PLACEHOLDER },
  // Google API keys.
  { pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g, replacement: PLACEHOLDER },
  // GitHub tokens (personal, oauth, server, refresh, user).
  { pattern: /\bgh[oprsu]_[A-Za-z0-9]{20,}/g, replacement: PLACEHOLDER },
  // Slack tokens.
  { pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/g, replacement: PLACEHOLDER },
  // Stripe-style keys.
  { pattern: /\b(?:sk|rk|pk)_(?:live|test)_[0-9A-Za-z]{10,}/g, replacement: PLACEHOLDER },
  // OpenAI / Anthropic style keys (sk-…, sk-ant-…, sk-proj-…).
  { pattern: /\bsk-[A-Za-z0-9_-]{20,}/g, replacement: PLACEHOLDER },
  // Bearer tokens in an Authorization header.
  { pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{10,}/gi, replacement: `Bearer ${PLACEHOLDER}` },
  // Credentials in a URL: scheme://user:pass@host → keep the scheme, cut creds.
  { pattern: /(\/\/)[^\s/@:]+:[^\s/@]+@/g, replacement: `$1${PLACEHOLDER}@` },
  // Labelled secrets: password=…, api_key: "…", client_secret=… — keep the label.
  {
    pattern:
      /\b(password|passwd|pwd|secret|token|api[_-]?key|access[_-]?key|client[_-]?secret)(["']?\s*[=:]\s*["']?)([^\s&"']+)/gi,
    replacement: `$1$2${PLACEHOLDER}`,
  },
];

export class RegexSecretRedactor implements SecretRedactor {
  redact(text: string): string {
    let result = text;
    for (const rule of RULES) {
      result = result.replace(rule.pattern, rule.replacement);
    }
    return result;
  }
}
