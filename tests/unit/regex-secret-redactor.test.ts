// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The default redactor. Proves it removes each well-known credential shape while
 * keeping the surrounding structure (a label, a URL scheme) readable, leaves
 * ordinary text — prices, dates, ids — untouched, and that `redactDeep` scrubs
 * string leaves anywhere inside a structured value.
 */

import { describe, expect, it } from 'vitest';

import { RegexSecretRedactor } from '../../src/redaction/regex-secret-redactor.js';
import { redactDeep } from '../../src/redaction/secret-redactor.js';

const redactor = new RegexSecretRedactor();
const redact = (text: string): string => redactor.redact(text);

describe('RegexSecretRedactor', () => {
  it('redacts an AWS access key id', () => {
    expect(redact('creds AKIAIOSFODNN7EXAMPLE end')).toBe('creds [REDACTED] end');
  });

  it('redacts a GitHub token', () => {
    expect(redact('token ghp_abcdefghijklmnopqrstuvwxyz0123456789 x')).toBe('token [REDACTED] x');
  });

  it('redacts a Slack token', () => {
    expect(redact('xoxb-123456789012-abcdefABCDEF')).toBe('[REDACTED]');
  });

  it('redacts an OpenAI/Anthropic style key', () => {
    expect(redact('use sk-ant-abcdefghijklmnopqrstuvwxyz now')).toBe('use [REDACTED] now');
  });

  it('redacts a Google API key', () => {
    expect(redact('AIzaSyD-abcdefghijklmnopqrstuvwxyz12345')).toBe('[REDACTED]');
  });

  it('redacts a JWT', () => {
    const jwt = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.abcdefghijklmno';
    expect(redact(`bearer body ${jwt}`)).toBe('bearer body [REDACTED]');
  });

  it('redacts a Bearer token but keeps the scheme word', () => {
    expect(redact('Authorization: Bearer abcdefghijklmnopqrstuv')).toBe(
      'Authorization: Bearer [REDACTED]',
    );
  });

  it('redacts credentials in a URL but keeps the scheme and host', () => {
    expect(redact('conn postgres://user:s3cr3tpass@db.internal:5432/app')).toBe(
      'conn postgres://[REDACTED]@db.internal:5432/app',
    );
  });

  it('redacts a labelled secret but keeps the label', () => {
    expect(redact('password=hunter2xyz9')).toBe('password=[REDACTED]');
    expect(redact('api_key: "abcd1234efgh"')).toBe('api_key: "[REDACTED]"');
  });

  it('redacts a PEM private key block', () => {
    const pem = '-----BEGIN RSA PRIVATE KEY-----\nMIIabc123\n-----END RSA PRIVATE KEY-----';
    expect(redact(`key:\n${pem}\ndone`)).toBe('key:\n[REDACTED]\ndone');
  });

  it('leaves ordinary text — prices, dates, ids — untouched', () => {
    const text = 'The price is $1,234.56 on 2026-08-01, order 998877, user ana@example.com.';
    expect(redact(text)).toBe(text);
  });
});

describe('redactDeep', () => {
  it('redacts string leaves anywhere inside a structured value', () => {
    const input = {
      note: 'ok',
      token: 'sk-abcdefghijklmnopqrstuvwx',
      nested: { list: ['plain', 'password=topsecret1'], count: 42 },
    };

    expect(redactDeep(redactor, input)).toEqual({
      note: 'ok',
      token: '[REDACTED]',
      nested: { list: ['plain', 'password=[REDACTED]'], count: 42 },
    });
  });

  it('passes non-string leaves through unchanged', () => {
    expect(redactDeep(redactor, 42)).toBe(42);
    expect(redactDeep(redactor, null)).toBe(null);
    expect(redactDeep(redactor, true)).toBe(true);
  });
});
