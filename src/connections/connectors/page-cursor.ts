// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Decoding the numeric cursors several connectors mint.
 *
 * `ResourcePage.nextCursor` is opaque by contract, and a connector is free to
 * put whatever it likes in it. Several put a number: GitHub and Slack count
 * pages from one, Jira and Cal.com count records from zero. What they had in
 * common was `Number(cursor)` with nothing checking it — so a cursor that was
 * not ours became `NaN`, went out in a query string, and came back as whatever
 * the source makes of `page=NaN`.
 *
 * A cursor this connector minted always parses. One that does not parse came
 * from somewhere else — another connector's page, a truncated copy-paste, a
 * caller inventing one — and the useful answer is to say so here rather than to
 * ask the source about it.
 */

import { ConnectorError } from '../connector.js';

/**
 * A 1-based page number: the cursor GitHub and Slack use.
 *
 * Absent means the first page, which is the only reason `cursor` is optional —
 * a caller who passes nothing wants the beginning, not an error.
 */
export function pageNumber(cursor: string | undefined, connectorId: string): number {
  return numeric(cursor, 1, 'a page number of 1 or more', connectorId);
}

/** A 0-based record offset: the cursor Jira and Cal.com use. */
export function startOffset(cursor: string | undefined, connectorId: string): number {
  return numeric(cursor, 0, 'a record offset of 0 or more', connectorId);
}

function numeric(
  cursor: string | undefined,
  minimum: number,
  expected: string,
  connectorId: string,
): number {
  if (!cursor) {
    return minimum;
  }
  const value = Number(cursor);
  // `Number.isInteger` covers NaN and Infinity too, which is the whole point:
  // every way a cursor can be wrong ends up in the same message.
  if (!Number.isInteger(value) || value < minimum) {
    throw new ConnectorError(`invalid cursor "${cursor}"; expected ${expected}`, connectorId);
  }
  return value;
}
