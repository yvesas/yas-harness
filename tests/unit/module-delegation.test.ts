// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The central agent delegates to the module the router chose.
 *
 * Doc 13, decision 3, on what holds from the start even under centralised
 * orchestration: *"módulos como agentes semi-autônomos — o central **delega**,
 * não microgerencia"*. It did not. The router picked a module, the decision was
 * written to the trace, and the turn then ran with every module's tools
 * flattened together — so a note-taking module could send an email because
 * some other module could.
 *
 * These tests are mostly about what a delegated turn is **not** allowed to see.
 */

import { describe, expect, it } from 'vitest';

import { Agent } from '../../src/core/agent.js';
import { ToolRegistry, ok } from '../../src/core/tool.js';
import type { Persona } from '../../src/core/persona.js';
import { InMemorySessionStore } from '../../src/memory/in-memory-session-store.js';
import { ModuleRegistry } from '../../src/modules/module.js';
import type { ModelGateway, ModelRequest, ModelResponse } from '../../src/models/model-gateway.js';
import { z } from 'zod';

const PERSONA: Persona = {
  id: 'default',
  name: 'Default',
  instructions: 'You are the product. Always answer in English.',
  task: 'reasoning',
  maxToolIterations: 8,
};

/** A gateway that answers plainly and records exactly what it was asked. */
function gateway() {
  const requests: ModelRequest[] = [];
  const model: ModelGateway = {
    complete: (request) => {
      requests.push(request);
      return Promise.resolve<ModelResponse>({
        model: 'test',
        content: [{ type: 'text', text: 'done' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
        latencyMs: 1,
      });
    },
  };
  return { model, requests };
}

function tool(name: string) {
  return {
    name,
    description: `The ${name} tool.`,
    input: z.object({}),
    execute: () => Promise.resolve(ok('ran')),
  };
}

function modules() {
  const notes = new ToolRegistry().register(tool('note_add'));
  const mail = new ToolRegistry().register(tool('send_email'));

  return new ModuleRegistry()
    .register({
      id: 'notes',
      description: 'Keeps notes.',
      tools: notes,
      agent: {
        instructions: 'Keep answers to one line.',
        task: 'simple',
        maxToolIterations: 2,
      },
    })
    .register({
      id: 'mail',
      description: 'Sends email.',
      tools: mail,
    });
}

async function build() {
  const sessions = new InMemorySessionStore();
  const session = await sessions.create({ tenantId: 'tenant-1', personaId: 'default' });
  const { model, requests } = gateway();

  const agent = new Agent({
    gateway: model,
    sessions,
    // Everything, as an unrouted turn would get.
    tools: new ToolRegistry().register(tool('note_add')).register(tool('send_email')),
    persona: PERSONA,
    modules: modules(),
  });

  return { agent, requests, sessionId: session.id };
}

const TURN = { tenantId: 'tenant-1', input: 'hello' };

describe('a routed turn runs as its module', () => {
  it('offers only that module’s tools', async () => {
    const { agent, requests, sessionId } = await build();

    await agent.run({ ...TURN, sessionId, moduleId: 'notes' });

    // The whole point. Before this, a note-taking turn could send an email
    // because some other module could.
    expect(requests[0]?.tools?.map((schema) => schema.name)).toEqual(['note_add']);
  });

  it('appends the module’s instructions instead of replacing the persona', async () => {
    const { agent, requests, sessionId } = await build();

    await agent.run({ ...TURN, sessionId, moduleId: 'notes' });

    // A module that could replace the whole system prompt could quietly undo
    // the product's voice, its language and its safety rules.
    expect(requests[0]?.system).toContain('Always answer in English.');
    expect(requests[0]?.system).toContain('Keep answers to one line.');
  });

  it('uses the module’s task kind, so a cheap module reaches a cheap model', async () => {
    const { agent, requests, sessionId } = await build();

    await agent.run({ ...TURN, sessionId, moduleId: 'notes' });

    expect(requests[0]?.task).toBe('simple');
  });

  it('falls back to the persona for anything the module did not say', async () => {
    const { agent, requests, sessionId } = await build();

    // `mail` declares no agent block at all.
    await agent.run({ ...TURN, sessionId, moduleId: 'mail' });

    expect(requests[0]?.task).toBe('reasoning');
    expect(requests[0]?.system).toBe(PERSONA.instructions);
    expect(requests[0]?.tools?.map((schema) => schema.name)).toEqual(['send_email']);
  });

  it('records which module answered, on the turn’s own first step', async () => {
    const { agent, sessionId } = await build();

    const reply = await agent.run({ ...TURN, sessionId, moduleId: 'notes' });

    // On the step, so a trace read months later says which module answered
    // without the reader having to find the routing step and trust that
    // nothing changed in between.
    expect(reply.traceId).toBeTruthy();
  });
});

describe('an unrouted turn is unchanged', () => {
  it('gets every tool the agent was built with', async () => {
    const { agent, requests, sessionId } = await build();

    await agent.run({ ...TURN, sessionId });

    // Exactly how the agent behaved before delegation existed. A caller that
    // skips the router, or a product with no modules, must not notice this.
    expect(requests[0]?.tools?.map((schema) => schema.name)).toEqual(['note_add', 'send_email']);
    expect(requests[0]?.system).toBe(PERSONA.instructions);
    expect(requests[0]?.task).toBe('reasoning');
  });

  it('ignores a module id when no registry was wired', async () => {
    const sessions = new InMemorySessionStore();
    const session = await sessions.create({ tenantId: 'tenant-1', personaId: 'default' });
    const { model, requests } = gateway();
    const agent = new Agent({
      gateway: model,
      sessions,
      tools: new ToolRegistry().register(tool('note_add')),
      persona: PERSONA,
    });

    await agent.run({ ...TURN, sessionId: session.id, moduleId: 'notes' });

    // A product that never registered modules should not be broken by a caller
    // that names one.
    expect(requests[0]?.tools?.map((schema) => schema.name)).toEqual(['note_add']);
  });
});

describe('a module the registry does not know', () => {
  it('fails rather than quietly running with everything', async () => {
    const { agent, sessionId } = await build();

    // Absorbing it would produce a plausible answer from the wrong thing,
    // which is the failure nobody notices. The router validates its own
    // output against the registry, so reaching here means somebody built a
    // turn by hand.
    await expect(agent.run({ ...TURN, sessionId, moduleId: 'ghost' })).rejects.toThrow(
      /not registered/,
    );
  });
});
