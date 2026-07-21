// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The agent loop, exercised end to end without a network or a database.
 * If any test here needs either, the ports have leaked.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { Agent } from '../../src/core/agent.js';
import { parsePersona } from '../../src/core/persona.js';
import { ToolRegistry, ok } from '../../src/core/tool.js';
import { InMemorySessionStore } from '../../src/memory/in-memory-session-store.js';
import { SessionNotFoundError } from '../../src/memory/session-store.js';
import type { ScriptedTurn } from '../../src/models/scripted-gateway.js';
import { ScriptedGateway, callsTool, says } from '../../src/models/scripted-gateway.js';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';

const persona = parsePersona(
  {
    id: 'test',
    name: 'Test persona',
    instructions: 'You are under test.',
    maxToolIterations: 3,
  },
  'test',
);

let sessions: InMemorySessionStore;

beforeEach(() => {
  sessions = new InMemorySessionStore();
});

function weatherTools(): ToolRegistry {
  return new ToolRegistry().register({
    name: 'get_weather',
    description: 'Return the weather for a city.',
    input: z.object({ city: z.string() }),
    execute: (input) => Promise.resolve(ok(`22C and clear in ${input.city}`)),
  });
}

async function runTurn(
  turns: readonly ScriptedTurn[],
  options: { tools?: ToolRegistry; input?: string } = {},
) {
  const gateway = new ScriptedGateway(turns);
  const session = await sessions.create({ tenantId: TENANT, personaId: persona.id });
  const agent = new Agent({
    gateway,
    sessions,
    tools: options.tools ?? new ToolRegistry(),
    persona,
  });

  const reply = await agent.run({
    tenantId: TENANT,
    sessionId: session.id,
    input: options.input ?? 'hello',
  });

  return { reply, gateway, session };
}

describe('Agent', () => {
  it('answers a plain question in one model call', async () => {
    const { reply, gateway } = await runTurn([says('Hi there.')]);

    expect(reply.text).toBe('Hi there.');
    expect(reply.stopReason).toBe('end_turn');
    expect(reply.modelCalls).toBe(1);
    expect(gateway.requests).toHaveLength(1);
  });

  it('sends the persona instructions as the system prompt', async () => {
    const { gateway } = await runTurn([says('ok')]);

    expect(gateway.requests[0]?.system).toBe('You are under test.');
    expect(gateway.requests[0]?.task).toBe('reasoning');
  });

  it('advertises no tools when none are registered', async () => {
    const { gateway } = await runTurn([says('ok')]);

    expect(gateway.requests[0]?.tools).toBeUndefined();
  });

  it('runs a requested tool and feeds the result back to the model', async () => {
    const { reply, gateway } = await runTurn(
      [callsTool('get_weather', { city: 'Recife' }), says('It is 22C in Recife.')],
      { tools: weatherTools(), input: 'weather in Recife?' },
    );

    expect(reply.text).toBe('It is 22C in Recife.');
    expect(reply.modelCalls).toBe(2);
    expect(reply.toolInvocations).toEqual([
      {
        name: 'get_weather',
        input: { city: 'Recife' },
        output: '22C and clear in Recife',
        isError: false,
      },
    ]);

    // The second call must carry the tool result back as a user turn.
    const secondCall = gateway.requests[1];
    expect(secondCall?.messages.at(-1)).toEqual({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          toolCallId: 'call-get_weather',
          content: '22C and clear in Recife',
          isError: false,
        },
      ],
    });
  });

  it('returns every tool result in a single turn so parallel calls keep working', async () => {
    const gateway = new ScriptedGateway([
      {
        content: [
          { type: 'tool_call', id: 'a', name: 'get_weather', input: { city: 'Recife' } },
          { type: 'tool_call', id: 'b', name: 'get_weather', input: { city: 'Olinda' } },
        ],
        stopReason: 'tool_call',
      },
      says('Both are warm.'),
    ]);
    const session = await sessions.create({ tenantId: TENANT, personaId: persona.id });
    const agent = new Agent({ gateway, sessions, tools: weatherTools(), persona });

    const reply = await agent.run({ tenantId: TENANT, sessionId: session.id, input: 'both?' });

    expect(reply.toolInvocations).toHaveLength(2);
    expect(gateway.requests[1]?.messages.at(-1)?.content).toHaveLength(2);
  });

  it('feeds a failing tool back as an error instead of aborting the turn', async () => {
    const tools = new ToolRegistry().register({
      name: 'get_weather',
      description: 'Return the weather for a city.',
      input: z.object({ city: z.string() }),
      execute: () => Promise.reject(new Error('provider down')),
    });

    const { reply } = await runTurn(
      [callsTool('get_weather', { city: 'Recife' }), says('I could not check that.')],
      { tools },
    );

    expect(reply.toolInvocations[0]?.isError).toBe(true);
    expect(reply.toolInvocations[0]?.output).toContain('provider down');
    expect(reply.text).toBe('I could not check that.');
  });

  it('refuses to run an approval-gated tool until approvals exist', async () => {
    const tools = new ToolRegistry().register({
      name: 'delete_everything',
      description: 'Destructive action.',
      input: z.object({}),
      requiresApproval: true,
      execute: () => Promise.reject(new Error('must never run')),
    });

    const { reply } = await runTurn(
      [callsTool('delete_everything', {}), says('I need approval.')],
      {
        tools,
      },
    );

    expect(reply.toolInvocations[0]?.isError).toBe(true);
    expect(reply.toolInvocations[0]?.output).toContain('requires human approval');
  });

  it('stops at the iteration limit rather than looping forever', async () => {
    const { reply } = await runTurn(
      [
        callsTool('get_weather', { city: 'A' }, 'a'),
        callsTool('get_weather', { city: 'B' }, 'b'),
        callsTool('get_weather', { city: 'C' }, 'c'),
      ],
      { tools: weatherTools() },
    );

    expect(reply.stopReason).toBe('iteration_limit');
    expect(reply.modelCalls).toBe(persona.maxToolIterations);
  });

  it('accumulates token usage across every call in the turn', async () => {
    const { reply } = await runTurn(
      [
        {
          ...callsTool('get_weather', { city: 'Recife' }),
          usage: { inputTokens: 100, outputTokens: 20 },
        },
        { ...says('done'), usage: { inputTokens: 150, outputTokens: 10, cachedInputTokens: 90 } },
      ],
      { tools: weatherTools() },
    );

    expect(reply.usage).toEqual({ inputTokens: 250, outputTokens: 30, cachedInputTokens: 90 });
  });

  it('persists the conversation so it survives a restart', async () => {
    const { session } = await runTurn(
      [callsTool('get_weather', { city: 'Recife' }), says('It is 22C.')],
      { tools: weatherTools(), input: 'weather?' },
    );

    const stored = await sessions.messages(TENANT, session.id);

    expect(stored.map((message) => message.role)).toEqual([
      'user', // the question
      'assistant', // the tool call
      'user', // the tool result
      'assistant', // the answer
    ]);
  });

  it('carries prior history into the next turn', async () => {
    const gateway = new ScriptedGateway([says('Hello Yves.'), says('Yves.')]);
    const session = await sessions.create({ tenantId: TENANT, personaId: persona.id });
    const agent = new Agent({ gateway, sessions, tools: new ToolRegistry(), persona });

    await agent.run({ tenantId: TENANT, sessionId: session.id, input: 'I am Yves.' });
    await agent.run({ tenantId: TENANT, sessionId: session.id, input: 'What is my name?' });

    expect(gateway.requests[1]?.messages).toHaveLength(3);
    expect(gateway.requests[1]?.messages[0]?.content).toEqual([
      { type: 'text', text: 'I am Yves.' },
    ]);
  });

  it('refuses a session that belongs to another tenant', async () => {
    const session = await sessions.create({ tenantId: TENANT, personaId: persona.id });
    const agent = new Agent({
      gateway: new ScriptedGateway([says('should not be reached')]),
      sessions,
      tools: new ToolRegistry(),
      persona,
    });

    await expect(
      agent.run({ tenantId: OTHER_TENANT, sessionId: session.id, input: 'leak it' }),
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });
});
