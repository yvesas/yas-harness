// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * What a turn leaves behind in its trace.
 *
 * The point of a trace is to answer "what happened" after the fact, so the
 * tests here assert on the shape of the whole turn rather than on individual
 * calls: the steps present, their order, and — for the endings that are not an
 * answer — that the trace says which ending it was.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Agent } from '../../src/core/agent.js';
import { parsePersona } from '../../src/core/persona.js';
import { ToolRegistry, ok, failed } from '../../src/core/tool.js';
import { InMemoryApprovalStore } from '../../src/approval/in-memory-approval-store.js';
import { InMemorySessionStore } from '../../src/memory/in-memory-session-store.js';
import type { ScriptedTurn } from '../../src/models/scripted-gateway.js';
import { ScriptedGateway, callsTool, says } from '../../src/models/scripted-gateway.js';
import { InMemoryTraceRecorder } from '../../src/telemetry/trace.js';

const TENANT = '11111111-1111-4111-8111-111111111111';

const persona = parsePersona(
  {
    id: 'test',
    name: 'Test persona',
    instructions: 'You are under test.',
    maxToolIterations: 2,
  },
  'test',
);

let sessions: InMemorySessionStore;
let traces: InMemoryTraceRecorder;

beforeEach(() => {
  sessions = new InMemorySessionStore();
  traces = new InMemoryTraceRecorder();
});

function tools(): ToolRegistry {
  return new ToolRegistry()
    .register({
      name: 'get_weather',
      description: 'Return the weather for a city.',
      input: z.object({ city: z.string() }),
      execute: (input) => Promise.resolve(ok(`22C and clear in ${input.city}`)),
    })
    .register({
      name: 'explode',
      description: 'Always fails.',
      input: z.object({}),
      execute: () => Promise.resolve(failed('nope')),
    });
}

async function runTurn(
  turns: readonly ScriptedTurn[],
  options: { approvals?: InMemoryApprovalStore; input?: string } = {},
) {
  const session = await sessions.create({ tenantId: TENANT, personaId: persona.id });
  const agent = new Agent({
    gateway: new ScriptedGateway(turns),
    sessions,
    tools: tools(),
    persona,
    traces,
    ...(options.approvals ? { approvals: options.approvals } : {}),
  });
  const reply = await agent.run({
    tenantId: TENANT,
    sessionId: session.id,
    input: options.input ?? 'what is the weather in Lisbon?',
  });
  return { agent, reply, session };
}

/** The turn as a reader would scan it: the kinds, in order. */
function kinds(traceId: string): string[] {
  return traces.trace(traceId).map((step) => step.kind);
}

describe('agent traces', () => {
  it('records a plain turn from input to reply', async () => {
    const { reply } = await runTurn([says('It is sunny.')]);

    expect(kinds(reply.traceId)).toEqual(['input', 'model_call', 'reply']);
    const [input, modelCall, ended] = traces.trace(reply.traceId);
    // The message itself is not copied in — it is already on the session.
    expect(input!.detail).toEqual({ characters: 'what is the weather in Lisbon?'.length });
    expect(modelCall).toMatchObject({ succeeded: true, label: 'scripted/reasoning' });
    expect(ended).toMatchObject({ label: 'end_turn', succeeded: true });
  });

  it('records each tool call with its name and input', async () => {
    const { reply } = await runTurn([
      callsTool('get_weather', { city: 'Lisbon' }),
      says('22C and clear.'),
    ]);

    expect(kinds(reply.traceId)).toEqual([
      'input',
      'model_call',
      'tool_call',
      'model_call',
      'reply',
    ]);
    expect(traces.trace(reply.traceId)[2]).toMatchObject({
      kind: 'tool_call',
      label: 'get_weather',
      succeeded: true,
      detail: { input: { city: 'Lisbon' } },
    });
  });

  it('marks a failed tool call as failed, with its reason', async () => {
    const { reply } = await runTurn([callsTool('explode', {}), says('That did not work.')]);

    const toolStep = traces.trace(reply.traceId).find((step) => step.kind === 'tool_call');
    expect(toolStep).toMatchObject({ label: 'explode', succeeded: false });
    expect(toolStep?.errorMessage).toContain('nope');
  });

  it('says the turn stopped for a human, and what it is waiting on', async () => {
    const approvals = new InMemoryApprovalStore();
    const gated = new ToolRegistry().register({
      name: 'send_email',
      description: 'Send an email.',
      input: z.object({ to: z.string() }),
      requiresApproval: true,
      execute: () => Promise.resolve(ok('sent')),
    });
    const session = await sessions.create({ tenantId: TENANT, personaId: persona.id });
    const agent = new Agent({
      gateway: new ScriptedGateway([callsTool('send_email', { to: 'a@b.c' })]),
      sessions,
      tools: gated,
      persona,
      approvals,
      traces,
    });

    const reply = await agent.run({ tenantId: TENANT, sessionId: session.id, input: 'email them' });

    expect(kinds(reply.traceId)).toEqual(['input', 'model_call', 'approval', 'reply']);
    expect(traces.trace(reply.traceId)[2]).toMatchObject({
      kind: 'approval',
      detail: { waitingOn: ['send_email'] },
    });
    expect(traces.trace(reply.traceId)[3]).toMatchObject({ label: 'awaiting_approval' });
  });

  it('says when a turn ran out of iterations instead of answering', async () => {
    // maxToolIterations is 2, and the model asks for a tool every time.
    const { reply } = await runTurn([
      callsTool('get_weather', { city: 'Lisbon' }),
      callsTool('get_weather', { city: 'Porto' }),
    ]);

    const ended = traces.trace(reply.traceId).at(-1);
    // An exhausted budget is not a success, and a trace that called it one
    // would hide the bug it exists to show.
    expect(ended).toMatchObject({ kind: 'reply', label: 'iteration_limit', succeeded: false });
  });

  it('records the model call that failed, then lets the error through', async () => {
    const session = await sessions.create({ tenantId: TENANT, personaId: persona.id });
    const agent = new Agent({
      gateway: new ScriptedGateway([]), // no turns: the first call throws
      sessions,
      tools: tools(),
      persona,
      traces,
    });

    await expect(
      agent.run({ tenantId: TENANT, sessionId: session.id, input: 'hello' }),
    ).rejects.toThrow(/ran out of turns/);

    const step = traces.steps.find((entry) => entry.kind === 'model_call');
    expect(step).toMatchObject({ succeeded: false });
    expect(step?.errorMessage).toContain('ran out of turns');
  });

  it('joins the turn to a trace the caller already started', async () => {
    const session = await sessions.create({ tenantId: TENANT, personaId: persona.id });
    const agent = new Agent({
      gateway: new ScriptedGateway([says('ok')]),
      sessions,
      tools: tools(),
      persona,
      traces,
    });

    const reply = await agent.run({
      tenantId: TENANT,
      sessionId: session.id,
      input: 'hello',
      traceId: '33333333-3333-4333-8333-333333333333',
    });

    expect(reply.traceId).toBe('33333333-3333-4333-8333-333333333333');
    expect(traces.trace(reply.traceId)).toHaveLength(3);
  });

  it('runs the turn unchanged when no recorder is wired', async () => {
    const session = await sessions.create({ tenantId: TENANT, personaId: persona.id });
    const agent = new Agent({
      gateway: new ScriptedGateway([says('It is sunny.')]),
      sessions,
      tools: tools(),
      persona,
    });

    const reply = await agent.run({ tenantId: TENANT, sessionId: session.id, input: 'hello' });

    expect(reply.text).toBe('It is sunny.');
    expect(traces.steps).toHaveLength(0);
  });
});
