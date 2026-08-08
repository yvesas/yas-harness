// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading `config/agents/`.
 *
 * One file per agent, so a diff says which agent changed and adding one does
 * not touch the others. A directory that is not there is not an error: a
 * deployment with no declared agents is a deployment whose modules are all in
 * code, which is how every product on the harness worked until now.
 *
 * A file that will not parse **stops startup**. The alternative — skipping it
 * and carrying on — gives a harness that is quietly missing an agent, and the
 * first sign is the router picking something else and answering plausibly.
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import { AgentConfigError, parseAgentConfig, type AgentConfig } from './agent-config.js';

export async function loadAgents(directory: string): Promise<AgentConfig[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const agents: AgentConfig[] = [];
  // Sorted, so the order a router sees does not depend on a filesystem.
  for (const entry of entries.filter((name) => extname(name) === '.json').sort()) {
    const path = join(directory, entry);
    const raw = await readFile(path, 'utf8');

    let source: unknown;
    try {
      source = JSON.parse(raw);
    } catch (error) {
      throw new AgentConfigError(
        `agent file ${entry} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    const config = parseAgentConfig(source, entry);

    // The file name and the id have to agree, because both are used to find an
    // agent: the console edits `<id>.json`, and the router returns the id. Two
    // names for one thing is how an edit lands on the wrong agent.
    const expected = basename(entry, '.json');
    if (config.id !== expected) {
      throw new AgentConfigError(
        `agent in ${entry} has id "${config.id}"; the file name must match it`,
      );
    }

    agents.push(config);
  }

  return agents;
}
