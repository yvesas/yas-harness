// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from 'vitest';

import type { ModelRequest, ModelResponse } from '../../src/models/model-gateway.js';
import { ModelGatewayError, userMessage } from '../../src/models/model-gateway.js';
import type { ModelProvider, ProviderCall } from '../../src/models/model-provider.js';
import { RoutedGateway } from '../../src/models/routed-gateway.js';
import { parseModelConfig } from '../../src/models/routing.js';
import { InMemoryUsageRecorder } from '../../src/telemetry/model-usage.js';

const TENANT = 'tenant-1';

const config = parseModelConfig(
  {
    models: {
      cheap: {
        provider: 'groq',
        model: 'llama',
        tier: 'cheap',
        price: { inputPerMTok: 1, outputPerMTok: 2, cachedInputPerMTok: 0.5 },
      },
      good: {
        provider: 'anthropic',
        model: 'opus',
        tier: 'premium',
        price: { inputPerMTok: 10, outputPerMTok: 20, cachedInputPerMTok: 1 },
      },
    },
    routes: {
      routing: ['cheap', 'good'],
      simple: ['cheap', 'good'],
      reasoning: ['good'],
      sensitive: ['good'],
    },
    attemptsPerModel: 2,
  },
  'test',
);

/** A provider that answers, or fails in a way the test dictates. */
class FakeProvider implements ModelProvider {
  readonly calls: ProviderCall[] = [];

  constructor(
    readonly name: string,
    private readonly behaviour: (call: number) => ModelResponse | Error,
  ) {}

  invoke(call: ProviderCall): Promise<ModelResponse> {
    this.calls.push(call);
    const outcome = this.behaviour(this.calls.length);
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  }
}

function answer(text: string, tokens = { input: 1000, output: 500 }): ModelResponse {
  return {
    model: text,
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { inputTokens: tokens.input, outputTokens: tokens.output, cachedInputTokens: 0 },
    latencyMs: 5,
  };
}

function retryable(message: string, provider: string): ModelGatewayError {
  return new ModelGatewayError(message, { provider, task: 'simple', retryable: true });
}

function permanent(message: string, provider: string): ModelGatewayError {
  return new ModelGatewayError(message, { provider, task: 'simple', retryable: false });
}

function request(overrides: Partial<ModelRequest> = {}): ModelRequest {
  return {
    task: 'simple',
    messages: [userMessage('hello')],
    attribution: { tenantId: TENANT, sessionId: 'session-1' },
    ...overrides,
  };
}

function build(providers: ModelProvider[], recorder = new InMemoryUsageRecorder()) {
  const gateway = new RoutedGateway({
    config,
    providers,
    recorder,
    sleep: () => Promise.resolve(), // no real backoff in tests
  });
  return { gateway, recorder };
}

describe('RoutedGateway', () => {
  it('uses the first candidate for the task', async () => {
    const groq = new FakeProvider('groq', () => answer('from-groq'));
    const anthropic = new FakeProvider('anthropic', () => answer('from-anthropic'));
    const { gateway } = build([groq, anthropic]);

    const response = await gateway.complete(request());

    expect(response.model).toBe('from-groq');
    expect(groq.calls[0]?.model).toBe('llama');
    expect(anthropic.calls).toHaveLength(0);
  });

  it('routes reasoning to the premium model', async () => {
    const groq = new FakeProvider('groq', () => answer('from-groq'));
    const anthropic = new FakeProvider('anthropic', () => answer('from-anthropic'));
    const { gateway } = build([groq, anthropic]);

    const response = await gateway.complete(request({ task: 'reasoning' }));

    expect(response.model).toBe('from-anthropic');
    expect(groq.calls).toHaveLength(0);
  });

  it('retries the same model on a transient failure', async () => {
    const groq = new FakeProvider('groq', (call) =>
      call === 1 ? retryable('rate limited', 'groq') : answer('recovered'),
    );
    const { gateway } = build([groq, new FakeProvider('anthropic', () => answer('unused'))]);

    const response = await gateway.complete(request());

    expect(response.model).toBe('recovered');
    expect(groq.calls).toHaveLength(2);
  });

  it('falls back to the next provider once a model is exhausted', async () => {
    const groq = new FakeProvider('groq', () => retryable('still down', 'groq'));
    const anthropic = new FakeProvider('anthropic', () => answer('from-anthropic'));
    const { gateway } = build([groq, anthropic]);

    const response = await gateway.complete(request());

    expect(response.model).toBe('from-anthropic');
    expect(groq.calls).toHaveLength(config.attemptsPerModel);
    expect(anthropic.calls).toHaveLength(1);
  });

  it('does not retry or fall back when the request itself was rejected', async () => {
    const groq = new FakeProvider('groq', () => permanent('invalid request', 'groq'));
    const anthropic = new FakeProvider('anthropic', () => answer('should not be reached'));
    const { gateway } = build([groq, anthropic]);

    await expect(gateway.complete(request())).rejects.toThrow(/invalid request/);
    expect(groq.calls).toHaveLength(1);
    expect(anthropic.calls).toHaveLength(0);
  });

  it('fails with the last error when every candidate is exhausted', async () => {
    const groq = new FakeProvider('groq', () => retryable('groq down', 'groq'));
    const anthropic = new FakeProvider('anthropic', () => retryable('anthropic down', 'anthropic'));
    const { gateway } = build([groq, anthropic]);

    await expect(gateway.complete(request())).rejects.toThrow(
      /every model for task "simple" failed after 4 attempt\(s\).*anthropic down/,
    );
  });

  it('refuses at construction to route to an unregistered provider', () => {
    expect(() => new RoutedGateway({ config, providers: [] })).toThrowError(
      /unregistered provider/,
    );
  });

  it('passes a deadline to the provider so a hung call cannot block a turn', async () => {
    const groq = new FakeProvider('groq', () => answer('ok'));
    const { gateway } = build([groq, new FakeProvider('anthropic', () => answer('unused'))]);

    await gateway.complete(request());

    expect(groq.calls[0]?.signal).toBeInstanceOf(AbortSignal);
  });

  describe('usage accounting', () => {
    it('prices the call using the model that answered', async () => {
      const { gateway, recorder } = build([
        new FakeProvider('groq', () => answer('ok', { input: 1_000_000, output: 1_000_000 })),
        new FakeProvider('anthropic', () => answer('unused')),
      ]);

      await gateway.complete(request());

      // 1M input at $1 + 1M output at $2, at the cheap model's prices.
      expect(recorder.records[0]?.costUsd).toBe(3);
      expect(recorder.records[0]?.modelReference).toBe('cheap');
    });

    it('attributes the cost to the tenant and the conversation', async () => {
      const { gateway, recorder } = build([
        new FakeProvider('groq', () => answer('ok')),
        new FakeProvider('anthropic', () => answer('unused')),
      ]);

      await gateway.complete(request());

      expect(recorder.records[0]).toMatchObject({
        tenantId: TENANT,
        sessionId: 'session-1',
        task: 'simple',
        succeeded: true,
      });
    });

    it('records failed attempts, so a flaky provider is visible', async () => {
      const { gateway, recorder } = build([
        new FakeProvider('groq', () => retryable('down', 'groq')),
        new FakeProvider('anthropic', () => answer('from-anthropic')),
      ]);

      await gateway.complete(request());

      expect(recorder.records.map((record) => [record.modelReference, record.succeeded])).toEqual([
        ['cheap', false],
        ['cheap', false],
        ['good', true],
      ]);
      expect(recorder.records[0]?.errorMessage).toContain('down');
    });

    it('keeps answering when the recorder itself fails', async () => {
      const brokenRecorder = {
        record: () => Promise.reject(new Error('usage table is gone')),
      };
      const gateway = new RoutedGateway({
        config,
        providers: [
          new FakeProvider('groq', () => answer('ok')),
          new FakeProvider('anthropic', () => answer('unused')),
        ],
        recorder: brokenRecorder,
        sleep: () => Promise.resolve(),
      });

      await expect(gateway.complete(request())).resolves.toMatchObject({ model: 'ok' });
    });
  });
});
