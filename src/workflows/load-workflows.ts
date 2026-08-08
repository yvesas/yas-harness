// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading `config/workflows/`.
 *
 * One file per workflow, versioned in Git like the agents beside them, and for
 * the same reasons: a diff says which workflow changed, and adding one does not
 * touch the others. A missing directory is not an error — a deployment with no
 * workflows is every deployment until somebody writes the first one.
 *
 * A file that will not parse stops startup, rather than leaving a harness that
 * is quietly missing a workflow somebody is about to look for.
 */

import { readdir, readFile } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';

import {
  WorkflowConfigError,
  parseWorkflowConfig,
  type WorkflowConfig,
} from './workflow-config.js';

export async function loadWorkflows(directory: string): Promise<WorkflowConfig[]> {
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    return [];
  }

  const workflows: WorkflowConfig[] = [];
  for (const entry of entries.filter((name) => extname(name) === '.json').sort()) {
    const raw = await readFile(join(directory, entry), 'utf8');

    let source: unknown;
    try {
      source = JSON.parse(raw);
    } catch (error) {
      throw new WorkflowConfigError(
        `workflow file ${entry} is not valid JSON: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }

    const config = parseWorkflowConfig(source, entry);

    const expected = basename(entry, '.json');
    if (config.id !== expected) {
      throw new WorkflowConfigError(
        `workflow in ${entry} has id "${config.id}"; the file name must match it`,
      );
    }

    workflows.push(config);
  }

  return workflows;
}
