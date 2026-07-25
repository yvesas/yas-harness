// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The eval framework itself, driven by a scripted router so the accuracy maths
 * is checked without a model. Products run the same runner against a real
 * gateway to measure their own router before trusting it.
 */

import { describe, expect, it } from 'vitest';

import { ToolRegistry } from '../../src/core/tool.js';
import { ModuleRegistry } from '../../src/modules/module.js';
import type { ScriptedTurn } from '../../src/models/scripted-gateway.js';
import { ScriptedGateway } from '../../src/models/scripted-gateway.js';
import { evaluateRouter, failures, routerCaseSetSchema } from '../../src/router/eval.js';
import { Router } from '../../src/router/router.js';

function decisionTurn(moduleId: string): ScriptedTurn {
  return {
    content: [
      { type: 'text', text: `{"moduleId":"${moduleId}","confidence":0.9,"reason":"test"}` },
    ],
    stopReason: 'end_turn',
  };
}

function modules(...ids: string[]): ModuleRegistry {
  const registry = new ModuleRegistry();
  for (const id of ids) {
    registry.register({ id, description: `Handles ${id}.`, tools: new ToolRegistry() });
  }
  return registry;
}

const cases = [
  { input: 'how much did I spend?', expected: 'finance' },
  { input: 'move my 3pm meeting', expected: 'calendar' },
  { input: 'what is my balance?', expected: 'finance' },
];

describe('router eval', () => {
  it('validates a case set and rejects an empty one', () => {
    expect(routerCaseSetSchema.safeParse(cases).success).toBe(true);
    expect(routerCaseSetSchema.safeParse([]).success).toBe(false);
  });

  it('reports full accuracy when every case routes as expected', async () => {
    const gateway = new ScriptedGateway([
      decisionTurn('finance'),
      decisionTurn('calendar'),
      decisionTurn('finance'),
    ]);
    const router = new Router(gateway, modules('finance', 'calendar'));

    const report = await evaluateRouter(router, cases);

    expect(report).toMatchObject({ total: 3, correct: 3, accuracy: 1 });
  });

  it('counts a wrong route as a miss and reports it', async () => {
    const gateway = new ScriptedGateway([
      decisionTurn('finance'),
      decisionTurn('finance'), // should have been calendar
      decisionTurn('finance'),
    ]);
    const router = new Router(gateway, modules('finance', 'calendar'));

    const report = await evaluateRouter(router, cases);

    expect(report.correct).toBe(2);
    expect(report.accuracy).toBeCloseTo(2 / 3);
    expect(failures(report)).toEqual([
      {
        input: 'move my 3pm meeting',
        expected: 'calendar',
        actual: 'finance',
        correct: false,
        confidence: 0.9,
      },
    ]);
  });

  it('counts a router that throws as a miss, not a crash', async () => {
    const gateway = new ScriptedGateway([
      decisionTurn('finance'),
      { content: [{ type: 'text', text: 'no json here' }], stopReason: 'end_turn' },
      decisionTurn('finance'),
    ]);
    const router = new Router(gateway, modules('finance', 'calendar'));

    const report = await evaluateRouter(router, cases);

    expect(report.correct).toBe(2);
    expect(failures(report)[0]?.error).toBeDefined();
    expect(failures(report)[0]?.actual).toBeNull();
  });
});
