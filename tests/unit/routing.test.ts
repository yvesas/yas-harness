// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ModelConfigError,
  candidatesFor,
  loadModelConfig,
  parseModelConfig,
} from '../../src/models/routing.js';

const CONFIG_PATH = join(process.cwd(), 'config', 'models.json');

const price = { inputPerMTok: 1, outputPerMTok: 2, cachedInputPerMTok: 0.1 };

function config(overrides: Record<string, unknown> = {}) {
  return {
    models: {
      cheap: { provider: 'groq', model: 'llama', tier: 'cheap', price },
      good: { provider: 'anthropic', model: 'opus', tier: 'premium', price },
    },
    routes: {
      routing: ['cheap'],
      simple: ['cheap', 'good'],
      reasoning: ['good'],
      sensitive: ['good'],
    },
    ...overrides,
  };
}

describe('model configuration', () => {
  it('applies defaults for timeout and attempts', () => {
    const parsed = parseModelConfig(config(), 'test');

    expect(parsed.requestTimeoutMs).toBe(120_000);
    expect(parsed.attemptsPerModel).toBe(2);
  });

  it('rejects a route naming a model that does not exist', () => {
    const broken = config({
      routes: { routing: ['ghost'], simple: ['cheap'], reasoning: ['good'], sensitive: ['good'] },
    });

    expect(() => parseModelConfig(broken, 'test')).toThrowError(/unknown model "ghost"/);
  });

  it('refuses to route sensitive work to a cheap model', () => {
    const unsafe = config({
      routes: { routing: ['cheap'], simple: ['cheap'], reasoning: ['good'], sensitive: ['cheap'] },
    });

    expect(() => parseModelConfig(unsafe, 'test')).toThrowError(
      /route "sensitive" must not use the cheap model/,
    );
  });

  it('refuses a cheap model anywhere in the sensitive fallback chain', () => {
    const unsafe = config({
      routes: {
        routing: ['cheap'],
        simple: ['cheap'],
        reasoning: ['good'],
        // The first choice is fine; the fallback is not.
        sensitive: ['good', 'cheap'],
      },
    });

    expect(() => parseModelConfig(unsafe, 'test')).toThrow(ModelConfigError);
  });

  it('rejects an empty route rather than leaving a task unserved', () => {
    const empty = config({
      routes: { routing: [], simple: ['cheap'], reasoning: ['good'], sensitive: ['good'] },
    });

    expect(() => parseModelConfig(empty, 'test')).toThrow(ModelConfigError);
  });

  it('resolves candidates in preference order', () => {
    const candidates = candidatesFor(parseModelConfig(config(), 'test'), 'simple');

    expect(candidates.map((candidate) => candidate.reference)).toEqual(['cheap', 'good']);
    expect(candidates[0]?.model).toBe('llama');
  });

  describe('the configuration shipped with the harness', () => {
    it('is valid, which means sensitive work never reaches a cheap model', async () => {
      const shipped = await loadModelConfig(CONFIG_PATH);

      expect(Object.keys(shipped.models).length).toBeGreaterThan(0);
      for (const candidate of candidatesFor(shipped, 'sensitive')) {
        expect(candidate.tier).toBe('premium');
      }
    });

    it('routes cheap work to a cheap model first', async () => {
      const shipped = await loadModelConfig(CONFIG_PATH);

      expect(candidatesFor(shipped, 'routing')[0]?.tier).toBe('cheap');
      expect(candidatesFor(shipped, 'simple')[0]?.tier).toBe('cheap');
    });

    it('gives every task a fallback except sensitive, which is pinned', async () => {
      const shipped = await loadModelConfig(CONFIG_PATH);

      expect(candidatesFor(shipped, 'routing').length).toBeGreaterThan(1);
      expect(candidatesFor(shipped, 'reasoning').length).toBeGreaterThan(1);
    });
  });
});
