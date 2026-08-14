// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The numeric cursors several connectors mint.
 *
 * The property worth pinning is the one that used to be missing: a cursor that
 * is not ours is refused here, rather than becoming `NaN` and going out in a
 * query string for the source to interpret.
 */

import { describe, expect, it } from 'vitest';

import { ConnectorError } from '../../src/connections/connector.js';
import { pageNumber, startOffset } from '../../src/connections/connectors/page-cursor.js';

describe('pageNumber', () => {
  it('starts at the first page when there is no cursor', () => {
    expect(pageNumber(undefined, 'github')).toBe(1);
    expect(pageNumber('', 'github')).toBe(1);
  });

  it('reads a page a previous call minted', () => {
    expect(pageNumber('4', 'github')).toBe(4);
  });

  it.each(['abc', '2.5', '0', '-1', 'Infinity', 'eyJvZmZzZXQiOjF9'])(
    'refuses %j rather than sending NaN to the source',
    (cursor) => {
      expect(() => pageNumber(cursor, 'github')).toThrowError(ConnectorError);
      expect(() => pageNumber(cursor, 'github')).toThrowError(/invalid cursor/);
    },
  );
});

describe('startOffset', () => {
  it('starts at zero when there is no cursor', () => {
    expect(startOffset(undefined, 'jira')).toBe(0);
  });

  it('accepts zero, which is a real offset rather than an absent one', () => {
    expect(startOffset('0', 'jira')).toBe(0);
    expect(startOffset('50', 'jira')).toBe(50);
  });

  it.each(['abc', '1.5', '-1'])('refuses %j', (cursor) => {
    expect(() => startOffset(cursor, 'jira')).toThrowError(/invalid cursor/);
  });

  it('names the connector that was asked, so a trace says where it came from', () => {
    expect(() => startOffset('nope', 'calcom')).toThrowError(
      expect.objectContaining({ connectorId: 'calcom' }) as Error,
    );
  });
});
