// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading and writing `config/agents/`.
 *
 * Separate from `config-files.ts` because the two have opposite shapes. That
 * one edits a fixed set of three files and refuses everything else by name.
 * This one edits a directory whose contents somebody creates, so the safety has
 * to come from the *id* rather than from a list.
 *
 * The id is validated against the harness's own pattern — lowercase, digits and
 * dashes — which contains no dot and no slash, so `../../.env` is not an id and
 * a path cannot be built out of one. Checked explicitly all the same: relying on
 * a regex somewhere else to be a path guard is how a path guard goes missing.
 *
 * Validation is `parseAgentConfig`, the same function the harness boots with.
 * Not a second schema that agrees today and drifts by Christmas.
 */

import { readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { parseAgentConfig, type AgentConfig } from 'yas-harness';

/** Mirrors the harness's id rule. An id that fails this is not a file name. */
const ID = /^[a-z][a-z0-9-]{1,63}$/;

export class AgentFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentFileError';
  }
}

function directory(): string {
  return join(process.env['CONFIG_DIR'] ?? join(process.cwd(), 'config'), 'agents');
}

/** Refuse anything that is not an id, whatever a form or a URL said. */
export function asAgentId(value: string): string {
  if (!ID.test(value)) {
    throw new AgentFileError(
      `"${value}" is not an agent id. Use lowercase letters, digits and dashes.`,
    );
  }
  return value;
}

function pathFor(id: string): string {
  return join(directory(), `${asAgentId(id)}.json`);
}

export async function listAgents(): Promise<AgentConfig[]> {
  let entries: string[];
  try {
    entries = await readdir(directory());
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];
  for (const entry of entries.filter((name) => name.endsWith('.json')).sort()) {
    try {
      const raw = await readFile(join(directory(), entry), 'utf8');
      agents.push(parseAgentConfig(JSON.parse(raw), entry));
    } catch {
      // A broken file stops the *harness* on purpose. It must not stop the page
      // that exists to fix it — the others still list, and the broken one shows
      // up as missing rather than as a crash.
      continue;
    }
  }
  return agents;
}

export async function readAgent(id: string): Promise<AgentConfig | null> {
  try {
    const raw = await readFile(pathFor(id), 'utf8');
    return parseAgentConfig(JSON.parse(raw), `${id}.json`);
  } catch {
    return null;
  }
}

/** The text of a file as it stands, for showing what a save would change. */
export async function readAgentText(id: string): Promise<string> {
  try {
    return await readFile(pathFor(id), 'utf8');
  } catch {
    return '';
  }
}

/**
 * Validate, then write. A file the harness would refuse never reaches the disk.
 *
 * The id inside the object and the file name are the same by construction here,
 * which is the rule `loadAgents` enforces on the way back in.
 */
export async function saveAgent(config: unknown): Promise<AgentConfig> {
  const parsed = parseAgentConfig(config, 'this form');
  await writeFile(pathFor(parsed.id), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  return parsed;
}

export async function deleteAgent(id: string): Promise<void> {
  await unlink(pathFor(id)).catch(() => undefined);
}
