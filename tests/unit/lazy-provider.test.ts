// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * A provider is not built until something calls it.
 *
 * Found by trying to start the whole stack with one command: creating a tenant
 * failed because a provider constructor wanted an API key. Reading a trace or a
 * cost table had the same problem — a key was required to do things that never
 * touch a model.
 *
 * What must *not* move is the wiring check. A route pointing at a provider
 * nobody registered is still caught while the gateway is built.
 */

import { describe, expect, it } from 'vitest';

import { LazyProvider } from '../../src/models/lazy-provider.js';
import type { ModelResponse } from '../../src/models/model-gateway.js';
import { ModelGatewayError, userMessage } from '../../src/models/model-gateway.js';
import type { ModelProvider } from '../../src/models/model-provider.js';
import { RoutedGateway } from '../../src/models/routed-gateway.js';
import { parseModelConfig } from '../../src/models/routing.js';

const config = parseModelConfig(
  {
    models: {
      good: {
        provider: 'anthropic',
        model: 'opus',
        tier: 'premium',
        price: { inputPerMTok: 10, outputPerMTok: 20, cachedInputPerMTok: 1 },
      },
    },
    routes: { routing: ['good'], simple: ['good'], reasoning: ['good'], sensitive: ['good'] },
    attemptsPerModel: 1,
  },
  'test',
);

function answering(name: string): ModelProvider {
  return {
    name,
    invoke: () =>
      Promise.resolve<ModelResponse>({
        model: name,
        content: [{ type: 'text', text: 'hello' }],
        stopReason: 'end_turn',
        usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
        latencyMs: 1,
      }),
  };
}

describe('a provider is built on first use', () => {
  it('does not build while the gateway is constructed', () => {
    let built = 0;
    const provider = new LazyProvider('anthropic', () => {
      built += 1;
      return answering('anthropic');
    });

    new RoutedGateway({ config, providers: [provider] });

    // The whole point: creating a tenant, reading a trace or showing a cost
    // table must not require an API key.
    expect(built).toBe(0);
    expect(provider.built).toBe(false);
  });

  it('builds when something actually calls the model', async () => {
    const provider = new LazyProvider('anthropic', () => answering('anthropic'));
    const gateway = new RoutedGateway({ config, providers: [provider] });

    await gateway.complete({ task: 'simple', messages: [userMessage('hi')] });

    expect(provider.built).toBe(true);
  });

  it('builds once, not per call', async () => {
    let built = 0;
    const provider = new LazyProvider('anthropic', () => {
      built += 1;
      return answering('anthropic');
    });
    const gateway = new RoutedGateway({ config, providers: [provider] });

    await gateway.complete({ task: 'simple', messages: [userMessage('hi')] });
    await gateway.complete({ task: 'simple', messages: [userMessage('again')] });

    // A provider holds a client; rebuilding it per call would throw away
    // whatever connection reuse the SDK manages.
    expect(built).toBe(1);
  });

  it('still fails at construction when a route names an unregistered provider', () => {
    // The mistake worth catching early, and it still is caught early: a
    // LazyProvider knows its name from the start, so only the credential
    // requirement moved.
    expect(() => new RoutedGateway({ config, providers: [] })).toThrow(ModelGatewayError);
  });

  it('reports the missing key at the call, saying the same thing it always said', async () => {
    const provider = new LazyProvider('anthropic', () => {
      throw new Error('ANTHROPIC_API_KEY is not set');
    });
    const gateway = new RoutedGateway({ config, providers: [provider] });

    // A deployment missing a key still finds out — at the moment it first tries
    // to use the model, with the message it would have had at boot.
    await expect(
      gateway.complete({ task: 'simple', messages: [userMessage('hi')] }),
    ).rejects.toThrow(/ANTHROPIC_API_KEY is not set/);
  });
});
