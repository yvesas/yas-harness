// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Where the harness says something went wrong that did not stop the turn.
 *
 * A port, and a deliberately small one. Almost nothing in `src/` logs: a
 * failure worth acting on is thrown, and a step worth reading is a trace. What
 * is left is the narrow case of a **degraded success** — the usage row that did
 * not land, the trace step that was lost, the compression pass that was skipped
 * — where failing the user's turn would cost more than the visibility does.
 *
 * It is a port rather than a direct `console.warn` for the reason every other
 * dependency here is one: the classes that need it inject everything else they
 * touch, down to `sleep` and `now`, and a global left a hole no test could see
 * through. A product that ships structured logs passes its own.
 */

export interface Logger {
  /** Something was lost, and the caller carried on anyway. */
  warn(message: string, fields?: Record<string, unknown>): void;
}

/**
 * The default: one JSON object per line on `console.warn`.
 *
 * JSON because a deployment reads these with the same tooling it reads
 * everything else with, and a message plus a loose object is two things a log
 * shipper has to guess how to join.
 */
export const consoleLogger: Logger = {
  warn(message: string, fields: Record<string, unknown> = {}): void {
    // Every call site is already inside a catch that chose not to fail the
    // turn. A field that cannot be serialised must not undo that choice, so it
    // costs the fields rather than the line.
    let line: string;
    try {
      line = JSON.stringify({ level: 'warn', message, ...fields });
    } catch {
      line = JSON.stringify({ level: 'warn', message });
    }
    console.warn(line);
  },
};
