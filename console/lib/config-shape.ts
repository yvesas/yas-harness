// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The parts of configuration editing that a browser is allowed to have.
 *
 * Separate from `config-files.ts` on purpose, and the separation is load-bearing
 * rather than tidy: that file imports `yas-harness` for the parsers, which pulls
 * in `pg`, which pulls in `net` and `dns`. A client component importing one
 * function from it drags the whole database driver towards the browser — which
 * is exactly what happened the first time, and failed loudly.
 *
 * So anything both sides need lives here, where there is nothing to drag.
 */

/** Which files the console is willing to touch. */
export type ConfigFile = 'models.json' | 'connectors.json' | 'personas/default.json';

export const EDITABLE: readonly ConfigFile[] = [
  'models.json',
  'connectors.json',
  'personas/default.json',
];

export interface DiffLine {
  readonly sign: '+' | '-' | ' ';
  readonly text: string;
}

/** A line-by-line diff, enough to see what a save would change. */
export function diff(before: string, after: string): DiffLine[] {
  const oldLines = before.split('\n');
  const newLines = after.split('\n');
  const lines: DiffLine[] = [];

  // Deliberately naive: equal length means a positional comparison, anything
  // else is shown whole. A console is not a merge tool, and a diff that guesses
  // wrong about a moved block is worse than one that says "this became that".
  if (oldLines.length === newLines.length) {
    for (const [index, line] of oldLines.entries()) {
      const replacement = newLines[index] ?? '';
      if (line === replacement) {
        lines.push({ sign: ' ', text: line });
      } else {
        lines.push({ sign: '-', text: line }, { sign: '+', text: replacement });
      }
    }
    return lines;
  }

  for (const line of oldLines) lines.push({ sign: '-', text: line });
  for (const line of newLines) lines.push({ sign: '+', text: line });
  return lines;
}
