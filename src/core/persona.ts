// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Persona: the agent's instructions, as configuration rather than code.
 *
 * Personas live in `config/personas/` so they can be versioned, reviewed and
 * changed without touching the loop. The harness has no opinion about what a
 * persona says — that is the product's business.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { z } from 'zod';

export const personaSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]{1,63}$/, 'id must be lowercase, digits and dashes'),
  /** Human-readable name, for operators rather than for the model. */
  name: z.string().min(1),
  /** The system prompt handed to the model on every turn. */
  instructions: z.string().min(1),
  /**
   * Task kind for this persona's own turns. Routing between modules always
   * uses the cheap tier regardless of what a persona asks for.
   */
  task: z.enum(['simple', 'reasoning', 'sensitive']).default('reasoning'),
  /** How many tool round-trips one user turn may take before giving up. */
  maxToolIterations: z.number().int().min(1).max(20).default(8),
});

export type Persona = z.infer<typeof personaSchema>;

export class PersonaError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'PersonaError';
  }
}

export function parsePersona(source: unknown, origin: string): Persona {
  const parsed = personaSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new PersonaError(`invalid persona in ${origin}: ${detail}`);
  }
  return parsed.data;
}

/**
 * Load a persona by id from a configuration directory.
 *
 * The id is checked against the file's own `id` field: a persona that has been
 * copied and not renamed is a configuration bug worth failing on.
 */
export async function loadPersona(id: string, directory: string): Promise<Persona> {
  const path = join(directory, `${id}.json`);

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    throw new PersonaError(`cannot read persona "${id}" from ${path}`, { cause: error });
  }

  let source: unknown;
  try {
    source = JSON.parse(raw);
  } catch (error) {
    throw new PersonaError(`persona "${id}" is not valid JSON`, { cause: error });
  }

  const persona = parsePersona(source, path);
  if (persona.id !== id) {
    throw new PersonaError(`persona in ${path} declares id "${persona.id}", expected "${id}"`);
  }
  return persona;
}
