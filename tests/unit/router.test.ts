// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../src/core/tool.js';
import { ModuleRegistry } from '../../src/modules/module.js';
import type { ScriptedTurn } from '../../src/models/scripted-gateway.js';
import { ScriptedGateway } from '../../src/models/scripted-gateway.js';
import { Router, RouterError } from '../../src/router/router.js';

function modules(...ids: string[]): ModuleRegistry {
  const registry = new ModuleRegistry();
  for (const id of ids) {
    registry.register({ id, description: `Handles ${id}.`, tools: new ToolRegistry() });
  }
  return registry;
}

function replies(text: string): ScriptedTurn {
  return { content: [{ type: 'text', text }], stopReason: 'end_turn' };
}

function routerWith(reply: string, ...ids: string[]) {
  const gateway = new ScriptedGateway([replies(reply)]);
  return { router: new Router(gateway, modules(...ids)), gateway };
}

describe('Router', () => {
  it('short-circuits a single module without calling the model', async () => {
    const gateway = new ScriptedGateway([]); // no turns: a call would throw
    const router = new Router(gateway, modules('only'));

    const decision = await router.route({ text: 'anything' });

    expect(decision).toEqual({
      moduleId: 'only',
      confidence: 1,
      reason: 'only module registered',
    });
    expect(gateway.requests).toHaveLength(0);
  });

  it('routes on the cheap tier', async () => {
    const { router, gateway } = routerWith(
      '{"moduleId":"finance","confidence":0.9,"reason":"about money"}',
      'finance',
      'calendar',
    );

    await router.route({ text: 'how much did I spend?' });

    expect(gateway.requests[0]?.task).toBe('routing');
  });

  it('returns the chosen module with its confidence and reason', async () => {
    const { router } = routerWith(
      '{"moduleId":"calendar","confidence":0.8,"reason":"about a meeting"}',
      'finance',
      'calendar',
    );

    const decision = await router.route({ text: 'move my 3pm' });

    expect(decision).toEqual({
      moduleId: 'calendar',
      confidence: 0.8,
      reason: 'about a meeting',
    });
  });

  it('lists every module with its description in the prompt', async () => {
    const { router, gateway } = routerWith(
      '{"moduleId":"finance","confidence":1,"reason":"x"}',
      'finance',
      'calendar',
    );

    await router.route({ text: 'q' });
    const prompt = gateway.requests[0]?.messages[0]?.content[0];

    expect(prompt).toMatchObject({ type: 'text' });
    const text = (prompt as { text: string }).text;
    expect(text).toContain('finance: Handles finance.');
    expect(text).toContain('calendar: Handles calendar.');
  });

  it('digs the JSON out of a reply that wraps it in prose or a fence', async () => {
    const { router } = routerWith(
      'Sure! ```json\n{"moduleId":"finance","confidence":0.7,"reason":"money"}\n``` hope that helps',
      'finance',
      'calendar',
    );

    const decision = await router.route({ text: 'q' });

    expect(decision.moduleId).toBe('finance');
  });

  it('handles a reason string that itself contains braces', async () => {
    const { router } = routerWith(
      '{"moduleId":"finance","confidence":0.7,"reason":"balance of {a,b}"}',
      'finance',
      'calendar',
    );

    const decision = await router.route({ text: 'q' });

    expect(decision.reason).toBe('balance of {a,b}');
  });

  it('rejects a choice that is not one of the registered modules', async () => {
    const { router } = routerWith(
      '{"moduleId":"weather","confidence":0.9,"reason":"guessing"}',
      'finance',
      'calendar',
    );

    await expect(router.route({ text: 'q' })).rejects.toThrowError(
      /unknown module "weather".*finance, calendar/s,
    );
  });

  it('fails clearly when the reply has no JSON at all', async () => {
    const { router } = routerWith('I am not sure which one.', 'finance', 'calendar');

    await expect(router.route({ text: 'q' })).rejects.toThrow(RouterError);
  });

  it('fails clearly on JSON of the wrong shape', async () => {
    const { router } = routerWith('{"module":"finance"}', 'finance', 'calendar');

    await expect(router.route({ text: 'q' })).rejects.toThrowError(/did not match the expected/);
  });

  it('rejects a confidence outside 0..1', async () => {
    const { router } = routerWith(
      '{"moduleId":"finance","confidence":9,"reason":"x"}',
      'finance',
      'calendar',
    );

    await expect(router.route({ text: 'q' })).rejects.toThrow(RouterError);
  });

  it('refuses to route with no modules registered', async () => {
    const router = new Router(new ScriptedGateway([]), new ModuleRegistry());

    await expect(router.route({ text: 'q' })).rejects.toThrowError(/no modules registered/);
  });

  it('passes attribution through so a routing call is costed', async () => {
    const { router, gateway } = routerWith(
      '{"moduleId":"finance","confidence":1,"reason":"x"}',
      'finance',
      'calendar',
    );

    await router.route({ text: 'q', attribution: { tenantId: 't1', sessionId: 's1' } });

    expect(gateway.requests[0]?.attribution).toEqual({ tenantId: 't1', sessionId: 's1' });
  });
});
