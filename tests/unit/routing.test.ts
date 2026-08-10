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

// The example, not `models.json` -- that one is a deployment's own file now,
// absent from a fresh clone. What these tests guard is the shape everybody
// starts from, which is exactly what the example is.
const CONFIG_PATH = join(process.cwd(), 'config', 'models.example.json');

const price = { inputPerMTok: 1, outputPerMTok: 2, cachedInputPerMTok: 0.1 };

function config(overrides: Record<string, unknown> = {}) {
  return {
    providers: {
      groq: {
        kind: 'openai-compatible',
        baseUrl: 'https://api.example.test/v1',
        apiKeyEnv: 'FAST_KEY',
      },
      anthropic: { kind: 'anthropic', apiKeyEnv: 'PREMIUM_KEY' },
    },
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

  it('refuses a model naming a provider nobody declared', () => {
    // Otherwise the mistake surfaces the first time that model is routed to —
    // which, for a fallback, can be weeks later and in production.
    expect(() =>
      parseModelConfig(
        config({ models: { ghost: { provider: 'nowhere', model: 'x', tier: 'cheap', price } } }),
        'test',
      ),
    ).toThrow(/undeclared provider "nowhere"/);
  });

  it('refuses an openai-compatible provider with nowhere to send the request', () => {
    expect(() =>
      parseModelConfig(
        {
          providers: { fast: { kind: 'openai-compatible', apiKeyEnv: 'K' } },
          models: { small: { provider: 'fast', model: 'a-model', tier: 'cheap', price } },
          routes: {
            routing: ['small'],
            simple: ['small'],
            reasoning: ['small'],
            sensitive: ['small'],
          },
        },
        'test',
      ),
    ).toThrow(/needs a baseUrl/);
  });

  it('names no vendor of its own — a provider is whatever the config calls it', () => {
    const parsed = parseModelConfig(
      {
        providers: {
          'the-fast-one': {
            kind: 'openai-compatible',
            baseUrl: 'https://api.example.test/v1',
            apiKeyEnv: 'WHATEVER_WE_CALL_IT',
          },
        },
        routes: {
          routing: ['small'],
          simple: ['small'],
          reasoning: ['small'],
          sensitive: ['premium'],
        },
        models: {
          small: { provider: 'the-fast-one', model: 'a-model', tier: 'cheap', price },
          premium: { provider: 'the-fast-one', model: 'a-bigger-model', tier: 'premium', price },
        },
      },
      'test',
    );

    // The harness knows `openai-compatible` as a wire format, and nothing about
    // whose endpoint is behind it.
    expect(parsed.providers['the-fast-one']?.baseUrl).toBe('https://api.example.test/v1');
  });
});

describe('the embedding provider’s name', () => {
  const base = {
    providers: {
      groq: { kind: 'openai-compatible', baseUrl: 'https://x.test/v1', apiKeyEnv: 'K' },
    },
    models: {
      cheap: {
        provider: 'groq',
        model: 'llama',
        tier: 'cheap',
        price: { inputPerMTok: 1, outputPerMTok: 2, cachedInputPerMTok: 0.5 },
      },
      good: {
        provider: 'groq',
        model: 'big',
        tier: 'premium',
        price: { inputPerMTok: 10, outputPerMTok: 20, cachedInputPerMTok: 1 },
      },
    },
    routes: { routing: ['cheap'], simple: ['cheap'], reasoning: ['good'], sensitive: ['good'] },
  };

  it('defaults to "embedding" and needs no key variable', () => {
    // No apiKeyEnv: a deployment where every tenant brings their own has no
    // platform key to name, and demanding one would put a secret in the
    // environment purely to satisfy a schema.
    const config = parseModelConfig(
      { ...base, embedding: { model: 'embed-small', baseUrl: 'https://x.test/v1' } },
      'test',
    );

    expect(config.embedding?.provider).toBe('embedding');
    expect(config.embedding?.apiKeyEnv).toBeUndefined();
  });

  it('may not be the name of a completion provider', () => {
    // Sharing a name would make an embedding key look to the router like a
    // completion key, so a tenant who paid only for knowledge would have their
    // turns routed as though they had brought a completion key.
    expect(() =>
      parseModelConfig(
        {
          ...base,
          embedding: { model: 'embed-small', baseUrl: 'https://x.test/v1', provider: 'groq' },
        },
        'test',
      ),
    ).toThrow(/its key is a different key/);
  });
});

describe('a key pasted where a variable name belongs', () => {
  it('is refused, with the place it should have gone', () => {
    // Somebody did this: a Groq key pasted into apiKeyEnv on the console's
    // config screen. No "is it an identifier" rule would catch it — a key is
    // letters, digits and underscores — but every provider key has lower case
    // in it and no environment variable anybody names does.
    expect(() =>
      parseModelConfig(
        config({
          providers: {
            groq: {
              kind: 'openai-compatible',
              baseUrl: 'https://api.example.test/v1',
              apiKeyEnv: 'gsk_aRealLookingKeyPastedByMistake',
            },
            anthropic: { kind: 'anthropic', apiKeyEnv: 'PREMIUM_KEY' },
          },
        }),
        'test',
      ),
    ).toThrow(/NAME of an environment variable.*Keys page/s);
  });

  it('still accepts an ordinary variable name', () => {
    expect(() => parseModelConfig(config(), 'test')).not.toThrow();
  });
});
