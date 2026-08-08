// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The wiring between steps, written as `{{...}}` in a prompt.
 *
 * This is deliberately the smallest substitution that could work: a name in
 * double braces, replaced by a string. No expressions, no conditionals, no
 * loops. A template language grows until it is a programming language, and a
 * programming language in a config file is a programming language nobody can
 * test — the step's prompt is the place to put judgement, and the model is what
 * exercises it.
 *
 * Two names exist: `{{input}}`, what the run was started with, and
 * `{{steps.<id>}}`, what an earlier step answered. Anything else is a mistake
 * caught when the file is read, not a blank silently pasted into a prompt.
 */

/** A name in braces: `{{input}}`, `{{steps.research}}`. */
const PLACEHOLDER = /\{\{\s*([a-zA-Z][a-zA-Z0-9._-]*)\s*\}\}/g;

export class TemplateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateError';
  }
}

/** Every name a template asks for, in the order it asks, without repeats. */
export function references(template: string): string[] {
  const found = new Set<string>();
  for (const match of template.matchAll(PLACEHOLDER)) {
    found.add(match[1]!);
  }
  return [...found];
}

/**
 * Fill a template.
 *
 * A name with no value throws rather than becoming an empty string. An empty
 * string is the failure that produces a confident answer about nothing: the
 * model is handed "Summarise the following:" with nothing following, and
 * summarises the instruction.
 */
export function render(template: string, values: Readonly<Record<string, string>>): string {
  return template.replace(PLACEHOLDER, (_, name: string) => {
    const value = values[name];
    if (value === undefined) {
      throw new TemplateError(`nothing to put in {{${name}}}`);
    }
    return value;
  });
}
