// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A workflow, declared rather than written.
 *
 * The router hands a turn to one agent and the turn ends. That is the right
 * shape for a question, and the wrong shape for work: "read the week's issues,
 * draft the summary, and let me see it before it is posted" is three agents and
 * a person, and until now the only way to express it was TypeScript.
 *
 * A workflow is an ordered list of steps. Each step names an agent and carries
 * a prompt; the prompt may quote what an earlier step answered. That is the
 * whole model — no branches, no loops, no parallel steps. Sequential work with
 * a place for a person to stand is what the product needs first, and a fake DAG
 * that only ever runs in a line would be a worse thing to have shipped.
 *
 * **What crosses between steps is only what the prompt names.** Each step runs
 * in its own session, so one agent's tool results never land in another's
 * context. Agents keep asking each other for things explicitly (doc 13,
 * decision 2) — a workflow schedules them, it does not merge them.
 *
 * The Golden Rule survives: an id, a name, a list of steps and some prose name
 * no domain. The domain is what somebody writes into the prompts.
 */

import { z } from 'zod';

import { references } from './template.js';

const IDENTIFIER = /^[a-z][a-z0-9-]{1,63}$/;

export const workflowStepSchema = z.object({
  /** Unique within the workflow; what `{{steps.<id>}}` names. */
  id: z.string().regex(IDENTIFIER, 'step id must be lowercase, digits and dashes'),
  /**
   * The agent that runs it — a declared agent's id, or a module a product
   * registered in code. Both are modules by the time a run starts, and a
   * workflow does not care which kind it got.
   */
  agent: z.string().regex(IDENTIFIER, 'agent must be lowercase, digits and dashes'),
  /** What that agent is asked, with `{{input}}` and `{{steps.<id>}}` filled in. */
  prompt: z.string().min(1),
  /**
   * Whether a person says yes before this step runs.
   *
   * Different from an agent's `approveWrites`, which gates the tool call. This
   * gates the *step*: nothing is sent to a model, no source is read, until
   * somebody approves. It is the gate for "let me see the draft before you
   * post it", and the draft is already in the run when the decision is asked.
   */
  approve: z.boolean().default(false),
});

export type WorkflowStep = z.infer<typeof workflowStepSchema>;

export const workflowConfigSchema = z.object({
  /** Matches the file name. */
  id: z.string().regex(IDENTIFIER, 'id must be lowercase, digits and dashes'),
  name: z.string().min(1),
  /** What this workflow is for, for a person choosing one to run. */
  description: z.string().min(1),
  /** What the person starting it is asked to supply, shown above the box. */
  inputLabel: z.string().min(1).default('What should this run work on?'),
  steps: z.array(workflowStepSchema).min(1),
});

export type WorkflowConfig = z.infer<typeof workflowConfigSchema>;

export class WorkflowConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkflowConfigError';
  }
}

export function parseWorkflowConfig(source: unknown, origin: string): WorkflowConfig {
  const parsed = workflowConfigSchema.safeParse(source);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new WorkflowConfigError(`invalid workflow in ${origin}: ${detail}`);
  }

  const config = parsed.data;
  const earlier = new Set<string>();

  for (const step of config.steps) {
    if (earlier.has(step.id)) {
      throw new WorkflowConfigError(
        `workflow "${config.id}" has two steps called "${step.id}" in ${origin}`,
      );
    }

    for (const name of references(step.prompt)) {
      if (name === 'input') {
        continue;
      }
      // Only backwards, and only to a step that exists. A forward reference is
      // the interesting case: it reads as if it would work, and at run time it
      // is a prompt with a hole in it or, worse, last run's answer.
      const target = name.startsWith('steps.') ? name.slice('steps.'.length) : null;
      if (target === null) {
        throw new WorkflowConfigError(
          `step "${step.id}" of workflow "${config.id}" asks for {{${name}}}, which is not ` +
            `{{input}} or {{steps.<id>}} (${origin})`,
        );
      }
      if (!earlier.has(target)) {
        throw new WorkflowConfigError(
          `step "${step.id}" of workflow "${config.id}" quotes step "${target}", which does not ` +
            `run before it (${origin})`,
        );
      }
    }

    earlier.add(step.id);
  }

  return config;
}

/**
 * The agents a workflow needs that are not registered.
 *
 * Checked when a run starts rather than when the file is read: modules are
 * registered by the product after the harness is assembled, so a workflow
 * loaded at startup can legitimately name an agent that does not exist yet.
 * Empty means it can run.
 */
export function missingAgents(config: WorkflowConfig, known: ReadonlySet<string>): string[] {
  const missing = new Set<string>();
  for (const step of config.steps) {
    if (!known.has(step.agent)) {
      missing.add(step.agent);
    }
  }
  return [...missing];
}
