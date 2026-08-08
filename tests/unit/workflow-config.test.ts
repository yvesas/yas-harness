// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { missingAgents, parseWorkflowConfig } from '../../src/workflows/workflow-config.js';
import { references, render, TemplateError } from '../../src/workflows/template.js';

const STEP = { id: 'research', agent: 'researcher', prompt: 'Look into {{input}}' };

function workflow(overrides: Record<string, unknown> = {}) {
  return { id: 'weekly', name: 'Weekly', description: 'A report', steps: [STEP], ...overrides };
}

describe('parseWorkflowConfig', () => {
  it('reads a workflow and defaults every step to ungated', () => {
    const config = parseWorkflowConfig(workflow(), 'weekly.json');

    expect(config.steps[0]?.approve).toBe(false);
    expect(config.inputLabel).toMatch(/work on/);
  });

  it('lets a later step quote an earlier one', () => {
    const config = parseWorkflowConfig(
      workflow({
        steps: [STEP, { id: 'draft', agent: 'writer', prompt: 'Write up {{steps.research}}' }],
      }),
      'weekly.json',
    );

    expect(config.steps).toHaveLength(2);
  });

  it('refuses a step that quotes one running after it', () => {
    // The interesting failure: it reads as if it would work, and at run time it
    // is a prompt with a hole in it.
    expect(() =>
      parseWorkflowConfig(
        workflow({
          steps: [{ id: 'draft', agent: 'writer', prompt: 'Write up {{steps.research}}' }, STEP],
        }),
        'weekly.json',
      ),
    ).toThrow(/does not run before it/);
  });

  it('refuses a step that quotes a step nobody declared', () => {
    expect(() =>
      parseWorkflowConfig(
        workflow({ steps: [{ ...STEP, prompt: 'Use {{steps.nowhere}}' }] }),
        'weekly.json',
      ),
    ).toThrow(/does not run before it/);
  });

  it('refuses a placeholder that is neither input nor a step', () => {
    expect(() =>
      parseWorkflowConfig(
        workflow({ steps: [{ ...STEP, prompt: 'Use {{secrets.token}}' }] }),
        'weekly.json',
      ),
    ).toThrow(/is not \{\{input\}\}/);
  });

  it('refuses two steps with the same id', () => {
    expect(() => parseWorkflowConfig(workflow({ steps: [STEP, STEP] }), 'weekly.json')).toThrow(
      /two steps called/,
    );
  });

  it('refuses a workflow with no steps', () => {
    expect(() => parseWorkflowConfig(workflow({ steps: [] }), 'weekly.json')).toThrow(
      /invalid workflow/,
    );
  });
});

describe('missingAgents', () => {
  it('names each unregistered agent once', () => {
    const config = parseWorkflowConfig(
      workflow({
        steps: [STEP, { id: 'draft', agent: 'researcher', prompt: 'x' }],
      }),
      'weekly.json',
    );

    expect(missingAgents(config, new Set())).toEqual(['researcher']);
    expect(missingAgents(config, new Set(['researcher']))).toEqual([]);
  });
});

describe('template', () => {
  it('lists what a prompt asks for, without repeats', () => {
    expect(references('{{input}} and {{steps.a}} and {{input}}')).toEqual(['input', 'steps.a']);
  });

  it('fills what it was given', () => {
    expect(render('Summarise {{steps.a}}', { 'steps.a': 'the notes' })).toBe('Summarise the notes');
  });

  it('refuses to leave a hole rather than pasting nothing', () => {
    // A blank here is the failure that produces a confident answer about
    // nothing: "Summarise the following:" with nothing following.
    expect(() => render('Summarise {{steps.a}}', {})).toThrow(TemplateError);
  });
});
