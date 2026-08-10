// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Reading `config/workflows/`, including the example that ships in the
 * repository — the connectors example was unloadable for a while precisely
 * because nothing loaded it.
 */

import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import { loadWorkflows } from '../../src/workflows/load-workflows.js';
import { parseWorkflowConfig } from '../../src/workflows/workflow-config.js';

async function directoryWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'workflows-'));
  for (const [name, body] of Object.entries(files)) {
    await writeFile(join(dir, name), body, 'utf8');
  }
  return dir;
}

const WEEKLY = JSON.stringify({
  id: 'weekly',
  name: 'Weekly',
  description: 'A report',
  steps: [{ id: 'research', agent: 'researcher', prompt: 'Look into {{input}}' }],
});

describe('loadWorkflows', () => {
  it('returns nothing when the directory is not there', async () => {
    // Every deployment, until somebody writes the first workflow.
    expect(await loadWorkflows(join(tmpdir(), 'not-a-directory-' + String(process.pid)))).toEqual(
      [],
    );
  });

  it('reads the json files and ignores everything else', async () => {
    const dir = await directoryWith({
      'weekly.json': WEEKLY,
      'README.md': '# not a workflow',
      'draft.json.example': '{ this is not json',
    });

    const workflows = await loadWorkflows(dir);

    expect(workflows.map((workflow) => workflow.id)).toEqual(['weekly']);
  });

  it('stops startup on a file that will not parse', async () => {
    const dir = await directoryWith({ 'weekly.json': '{ nope' });

    // Skipping it would leave a harness quietly missing a workflow, and the
    // first sign would be somebody looking for it in a list.
    await expect(loadWorkflows(dir)).rejects.toThrow(/not valid JSON/);
  });

  it('refuses a workflow whose id does not match its file name', async () => {
    const dir = await directoryWith({ 'monthly.json': WEEKLY });

    await expect(loadWorkflows(dir)).rejects.toThrow(/the file name must match it/);
  });

  it('loads the example that ships in this repository', async () => {
    // It is copied by whoever tries workflows for the first time. An example
    // that does not parse is a first impression that fails.
    const { readFile } = await import('node:fs/promises');
    const raw = await readFile('config/workflows/weekly-summary.json.example', 'utf8');

    const config = parseWorkflowConfig(JSON.parse(raw), 'weekly-summary.json.example');

    expect(config.steps.at(-1)?.approve).toBe(true);
  });
});
