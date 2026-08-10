// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Several agents in order, without a network or a database.
 *
 * Three things matter enough to prove here. That a step is actually run **as
 * its agent** — the whole point of a workflow is that the writer and the
 * researcher are different, with different tools. That what crosses between
 * steps is only what a prompt quotes, so one agent's tool results never appear
 * in another's context. And that both pauses work: the step gate, where nothing
 * has run yet, and the write gate firing mid-turn, where the held call has to
 * resume as the same module or it is looked up in the wrong registry.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { InMemoryApprovalStore } from '../../src/approval/in-memory-approval-store.js';
import { Agent } from '../../src/core/agent.js';
import { parsePersona } from '../../src/core/persona.js';
import { ToolRegistry, ok } from '../../src/core/tool.js';
import { InMemorySessionStore } from '../../src/memory/in-memory-session-store.js';
import { ModuleRegistry } from '../../src/modules/module.js';
import type { ScriptedTurn } from '../../src/models/scripted-gateway.js';
import { ScriptedGateway, callsTool, says } from '../../src/models/scripted-gateway.js';
import { InMemoryWorkflowRunStore } from '../../src/workflows/in-memory-workflow-run-store.js';
import { parseWorkflowConfig, type WorkflowConfig } from '../../src/workflows/workflow-config.js';
import { WorkflowError, WorkflowRunner } from '../../src/workflows/workflow-runner.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

const persona = parsePersona(
  { id: 'test', name: 'Test', instructions: 'You are under test.', maxToolIterations: 4 },
  'test',
);

let sessions: InMemorySessionStore;
let approvals: InMemoryApprovalStore;
let runs: InMemoryWorkflowRunStore;
let ran: string[];

beforeEach(() => {
  sessions = new InMemorySessionStore();
  approvals = new InMemoryApprovalStore();
  runs = new InMemoryWorkflowRunStore();
  ran = [];
});

/** Two agents with different tools, so "which one ran" is answerable. */
function modules(): ModuleRegistry {
  return new ModuleRegistry()
    .register({
      id: 'researcher',
      description: 'Reads things.',
      agent: { instructions: 'You read.' },
      tools: new ToolRegistry().register({
        name: 'look_up',
        description: 'Look something up.',
        input: z.object({ topic: z.string() }),
        execute: (input) => {
          ran.push(`look_up:${input.topic}`);
          return Promise.resolve(ok(`notes on ${input.topic}`));
        },
      }),
    })
    .register({
      id: 'publisher',
      description: 'Posts things.',
      agent: { instructions: 'You post.' },
      tools: new ToolRegistry().register({
        name: 'post',
        description: 'Post it. Destructive.',
        input: z.object({ body: z.string() }),
        requiresApproval: true,
        execute: (input) => {
          ran.push(`post:${input.body}`);
          return Promise.resolve(ok('posted'));
        },
      }),
    });
}

function runnerWith(config: WorkflowConfig, turns: readonly ScriptedTurn[]) {
  const registry = modules();
  const gateway = new ScriptedGateway(turns);
  const agent = new Agent({
    gateway,
    sessions,
    tools: new ToolRegistry(),
    persona,
    approvals,
    modules: registry,
  });
  const runner = new WorkflowRunner({
    agent,
    sessions,
    runs,
    workflows: new Map([[config.id, config]]),
    agents: () => new Set(registry.list().map((module) => module.id)),
    approvals,
    personaId: persona.id,
  });
  return { runner, gateway };
}

const TWO_STEPS = parseWorkflowConfig(
  {
    id: 'weekly',
    name: 'Weekly report',
    description: 'Research, then post.',
    steps: [
      { id: 'research', agent: 'researcher', prompt: 'Look into {{input}}' },
      { id: 'publish', agent: 'publisher', prompt: 'Post this: {{steps.research}}' },
    ],
  },
  'weekly.json',
);

describe('WorkflowRunner', () => {
  it('runs each step as its own agent, quoting the one before it', async () => {
    const { runner } = runnerWith(TWO_STEPS, [
      callsTool('look_up', { topic: 'pricing' }),
      says('pricing went up 4%'),
      says('posted the summary'),
    ]);

    const { run, steps } = await runner.start({
      tenantId: TENANT,
      workflowId: 'weekly',
      input: 'pricing',
    });

    expect(run.status).toBe('completed');
    expect(steps.map((step) => step.agentId)).toEqual(['researcher', 'publisher']);
    // The second step's prompt carries the first step's answer — and only that.
    expect(steps[1]?.prompt).toBe('Post this: pricing went up 4%');
    expect(steps[0]?.output).toBe('pricing went up 4%');
    // The researcher's tool was reachable; it belongs to that module alone.
    expect(ran).toContain('look_up:pricing');
  });

  it('gives each step its own conversation', async () => {
    const { runner } = runnerWith(TWO_STEPS, [says('the notes'), says('posted')]);

    const { steps } = await runner.start({
      tenantId: TENANT,
      workflowId: 'weekly',
      input: 'pricing',
    });

    // Separate sessions is what keeps one agent's tool results out of another's
    // context. Sharing one would make a workflow the back door around agents
    // asking each other for things.
    expect(steps[0]?.sessionId).not.toBe(steps[1]?.sessionId);
    const second = await sessions.messages(TENANT, steps[1]!.sessionId!);
    expect(JSON.stringify(second)).not.toContain('look_up');
  });

  it('stops for a person before a gated step runs, and costs nothing while it waits', async () => {
    const gated = parseWorkflowConfig(
      {
        id: 'weekly',
        name: 'Weekly report',
        description: 'Research, then post with a look first.',
        steps: [
          { id: 'research', agent: 'researcher', prompt: 'Look into {{input}}' },
          {
            id: 'publish',
            agent: 'publisher',
            prompt: 'Post this: {{steps.research}}',
            approve: true,
          },
        ],
      },
      'weekly.json',
    );
    const { runner, gateway } = runnerWith(gated, [says('the notes'), says('posted')]);

    const first = await runner.start({
      tenantId: TENANT,
      workflowId: 'weekly',
      input: 'pricing',
    });

    expect(first.run.status).toBe('awaiting_approval');
    // Nothing was sent to a model for the gated step: the gate is about whether
    // it should run at all, so the second scripted turn is untouched.
    expect(gateway.requests.length).toBe(1);

    const [waiting] = await approvals.pending(TENANT);
    // What a person sees is the rendered prompt, not the template.
    expect((waiting?.input as { prompt: string }).prompt).toBe('Post this: the notes');

    await approvals.approve(TENANT, waiting!.id, { decidedBy: 'yves' });
    const second = await runner.resume(TENANT, first.run.id);

    expect(second.run.status).toBe('completed');
    expect(second.steps.map((step) => step.status)).toEqual(['completed', 'completed']);
    // The first step was not run again on resume.
    expect(gateway.requests.length).toBe(2);
  });

  it('stops the run when a person declines a step', async () => {
    const gated = parseWorkflowConfig(
      {
        id: 'weekly',
        name: 'Weekly',
        description: 'Post, with a look first.',
        steps: [{ id: 'publish', agent: 'publisher', prompt: 'Post {{input}}', approve: true }],
      },
      'weekly.json',
    );
    const { runner } = runnerWith(gated, [says('posted')]);

    const first = await runner.start({ tenantId: TENANT, workflowId: 'weekly', input: 'x' });
    const [waiting] = await approvals.pending(TENANT);
    await approvals.reject(TENANT, waiting!.id, { decidedBy: 'yves', reason: 'not this week' });

    const second = await runner.resume(TENANT, first.run.id);

    expect(second.run.status).toBe('failed');
    expect(second.run.error).toMatch(/not this week/);
    expect(second.steps[0]?.status).toBe('skipped');
    expect(ran).toEqual([]);
  });

  it('resumes an agent’s own write gate as the same agent', async () => {
    const { runner } = runnerWith(TWO_STEPS, [
      says('the notes'),
      callsTool('post', { body: 'the notes' }),
      says('done'),
    ]);

    const first = await runner.start({ tenantId: TENANT, workflowId: 'weekly', input: 'pricing' });

    expect(first.run.status).toBe('awaiting_approval');
    expect(first.steps[1]?.awaiting).toBe('tool');
    expect(ran).toEqual([]);

    const [waiting] = await approvals.pending(TENANT);
    await approvals.approve(TENANT, waiting!.id, { decidedBy: 'yves' });
    const second = await runner.resume(TENANT, first.run.id);

    // The held call belongs to the publisher's registry. Resuming without the
    // module would look it up among the agent's own tools and not find it.
    expect(ran).toEqual(['post:the notes']);
    expect(second.run.status).toBe('completed');
  });

  it('stops the run at the step that failed, rather than quoting the failure onward', async () => {
    // No scripted turns at all: the very first model call rejects.
    const { runner } = runnerWith(TWO_STEPS, []);

    const result = await runner.start({
      tenantId: TENANT,
      workflowId: 'weekly',
      input: 'pricing',
    });

    expect(result.run.status).toBe('failed');
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]?.status).toBe('failed');
  });

  it('refuses to start a workflow naming an agent nobody registered', async () => {
    const unknown = parseWorkflowConfig(
      {
        id: 'weekly',
        name: 'Weekly',
        description: 'x',
        steps: [{ id: 'only', agent: 'nobody', prompt: '{{input}}' }],
      },
      'weekly.json',
    );
    const { runner } = runnerWith(unknown, [says('x')]);

    await expect(
      runner.start({ tenantId: TENANT, workflowId: 'weekly', input: 'x' }),
    ).rejects.toThrow(/not registered: nobody/);
    // And left no run behind to go and read.
    expect(await runs.list(TENANT)).toEqual([]);
  });

  it('refuses a gated workflow when no queue is wired, rather than running it ungated', async () => {
    const gated = parseWorkflowConfig(
      {
        id: 'weekly',
        name: 'Weekly',
        description: 'x',
        steps: [{ id: 'publish', agent: 'publisher', prompt: '{{input}}', approve: true }],
      },
      'weekly.json',
    );
    const registry = modules();
    const runner = new WorkflowRunner({
      agent: new Agent({
        gateway: new ScriptedGateway([says('x')]),
        sessions,
        tools: new ToolRegistry(),
        persona,
        modules: registry,
      }),
      sessions,
      runs,
      workflows: new Map([[gated.id, gated]]),
      agents: () => new Set(registry.list().map((module) => module.id)),
      personaId: persona.id,
    });

    await expect(
      runner.start({ tenantId: TENANT, workflowId: 'weekly', input: 'x' }),
    ).rejects.toThrow(WorkflowError);
  });

  it('does not start a finished run over when resume is pressed twice', async () => {
    const { runner, gateway } = runnerWith(TWO_STEPS, [says('notes'), says('posted')]);

    const first = await runner.start({ tenantId: TENANT, workflowId: 'weekly', input: 'x' });
    const again = await runner.resume(TENANT, first.run.id);

    expect(again.run.status).toBe('completed');
    expect(gateway.requests.length).toBe(2);
  });

  it('never reaches another tenant’s run', async () => {
    const { runner } = runnerWith(TWO_STEPS, [says('notes'), says('posted')]);
    const mine = await runner.start({ tenantId: TENANT, workflowId: 'weekly', input: 'x' });

    const other = '22222222-2222-4222-8222-222222222222';
    await expect(runner.resume(other, mine.run.id)).rejects.toThrow(/not found/);
    expect(await runner.detail(other, mine.run.id)).toBeNull();
  });
});
