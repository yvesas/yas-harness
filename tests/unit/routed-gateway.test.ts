// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from 'vitest';

import type { ContextCompressor } from '../../src/compression/context-compressor.js';
import { compressorFor } from '../../src/compression/profiles.js';
import type { ModelRequest, ModelResponse } from '../../src/models/model-gateway.js';
import { ModelGatewayError, userMessage } from '../../src/models/model-gateway.js';
import type { ModelProvider, ProviderCall } from '../../src/models/model-provider.js';
import { RoutedGateway } from '../../src/models/routed-gateway.js';
import { parseModelConfig } from '../../src/models/routing.js';
import { RegexSecretRedactor } from '../../src/redaction/regex-secret-redactor.js';
import { InMemoryUsageRecorder } from '../../src/telemetry/model-usage.js';

const TENANT = 'tenant-1';

const config = parseModelConfig(
  {
    providers: {
      groq: {
        kind: 'openai-compatible',
        baseUrl: 'https://api.example.test/v1',
        apiKeyEnv: 'FAST_KEY',
      },
      anthropic: { kind: 'anthropic', apiKeyEnv: 'PREMIUM_KEY' },
    },
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

    it('redacts secrets from the error it logs when recording fails', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const gateway = new RoutedGateway({
          config,
          providers: [
            new FakeProvider('groq', () => answer('ok')),
            new FakeProvider('anthropic', () => answer('unused')),
          ],
          recorder: {
            record: () =>
              Promise.reject(new Error('write to postgres://user:s3cr3tpass@db failed')),
          },
          redactor: new RegexSecretRedactor(),
          sleep: () => Promise.resolve(),
        });

        await gateway.complete(request());

        expect(warn).toHaveBeenCalledWith(
          'failed to record model usage',
          expect.objectContaining({ error: 'write to postgres://[REDACTED]@db failed' }),
        );
      } finally {
        warn.mockRestore();
      }
    });
  });

  describe('context compression', () => {
    /** Trailing whitespace and blank runs: what the whitespace engine removes. */
    const padded = request({
      messages: [userMessage('hello   \n\n\n\nworld')],
    });

    function withCompressor(compressor: ContextCompressor) {
      const recorder = new InMemoryUsageRecorder();
      const provider = new FakeProvider('groq', () => answer('ok'));
      const gateway = new RoutedGateway({
        config,
        providers: [provider, new FakeProvider('anthropic', () => answer('unused'))],
        recorder,
        compressor,
        sleep: () => Promise.resolve(),
      });
      return { gateway, recorder, provider };
    }

    it('sends the compressed request and records what it saved', async () => {
      const { gateway, recorder, provider } = withCompressor(compressorFor('light'));

      await gateway.complete(padded);

      const sent = provider.calls[0]!.request.messages[0]!.content[0]!;
      expect(sent).toMatchObject({ type: 'text', text: 'hello\n\nworld' });
      const { compression } = recorder.records[0]!;
      expect(compression!.afterTokens).toBeLessThan(compression!.beforeTokens);
    });

    it('leaves the request and the record alone when no compressor is wired', async () => {
      const { gateway, recorder } = build([
        new FakeProvider('groq', () => answer('ok')),
        new FakeProvider('anthropic', () => answer('unused')),
      ]);

      await gateway.complete(padded);

      // Null in the database means "compression was never wired", which is a
      // different fact from "it ran and saved nothing".
      expect(recorder.records[0]!.compression).toBeUndefined();
    });

    it('compresses once, not per attempt in the fallback chain', async () => {
      const compressor = compressorFor('light');
      const calls = { count: 0 };
      const counting: ContextCompressor = {
        compress: (input) => {
          calls.count += 1;
          return compressor.compress(input);
        },
      };
      const gateway = new RoutedGateway({
        config,
        providers: [
          new FakeProvider('groq', () => retryable('rate limited', 'groq')),
          new FakeProvider('anthropic', () => answer('recovered')),
        ],
        recorder: new InMemoryUsageRecorder(),
        compressor: counting,
        sleep: () => Promise.resolve(),
      });

      await gateway.complete(request({ task: 'simple' }));

      expect(calls.count).toBe(1);
    });

    it('sends the request uncompressed rather than losing the turn to a broken engine', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        const { gateway, recorder, provider } = withCompressor({
          compress: () => {
            throw new Error('engine exploded');
          },
        });

        const response = await gateway.complete(padded);

        expect(response.model).toBe('ok');
        // Untouched: the floor for a compression fault is "no change".
        expect(provider.calls[0]!.request.messages[0]!.content[0]).toMatchObject({
          text: 'hello   \n\n\n\nworld',
        });
        expect(recorder.records[0]!.compression).toBeUndefined();
        expect(warn).toHaveBeenCalledWith(
          'context compression failed; sending the request uncompressed',
          expect.objectContaining({ task: 'simple' }),
        );
      } finally {
        warn.mockRestore();
      }
    });

    it('counts the untouched cacheable prefix in what the call sent', async () => {
      // Enough padding on both sides that the difference is whole tokens, not
      // a rounding artefact: a few trailing spaces are worth less than a token.
      const messages = [
        userMessage(`stable handbook${'\n'.repeat(40)}text`),
        userMessage(`tail${'\n'.repeat(40)}end`),
      ];
      const withPrefix = withCompressor(compressorFor('light'));
      const withoutPrefix = withCompressor(compressorFor('light'));

      await withPrefix.gateway.complete(request({ messages, cachePrefix: { stableMessages: 1 } }));
      await withoutPrefix.gateway.complete(request({ messages }));

      const declared = withPrefix.recorder.records[0]!.compression!;
      const undeclared = withoutPrefix.recorder.records[0]!.compression!;

      // Both calls sent the same request, so both report the same starting
      // size — the prefix is excluded from compression, not from the total.
      // Leaving it out would inflate the saving the call actually made. The
      // two are not bit-identical: with a prefix declared the total is two
      // regions counted separately, and a tokenizer splits differently across
      // a boundary it no longer sees. A token of drift, well inside the
      // counter's own approximation, is the price of the split.
      expect(Math.abs(declared.beforeTokens - undeclared.beforeTokens)).toBeLessThanOrEqual(2);
      // And declaring it costs real saving: the prefix is left alone.
      expect(declared.afterTokens).toBeGreaterThan(undeclared.afterTokens);
      expect(declared.afterTokens).toBeLessThan(declared.beforeTokens);
    });
  });
});

describe('a model that declares its own output ceiling', () => {
  it('is asked for no more than that, whatever the caller wanted', async () => {
    // Providers count the ceiling you ask for against a per-minute budget
    // before reading the prompt, so a default that suits one model rejects
    // every request to another — a 413 on the first call, with any prompt.
    const provider = new FakeProvider('groq', () => answer('ok'));
    const gateway = new RoutedGateway({
      config: parseModelConfig(
        {
          providers: {
            groq: { kind: 'openai-compatible', baseUrl: 'https://x.test/v1', apiKeyEnv: 'K' },
          },
          models: {
            small: {
              provider: 'groq',
              model: 'llama-instant',
              tier: 'cheap',
              price: { inputPerMTok: 1, outputPerMTok: 1, cachedInputPerMTok: 1 },
              maxOutputTokens: 2000,
            },
            big: {
              provider: 'groq',
              model: 'llama-versatile',
              tier: 'premium',
              price: { inputPerMTok: 1, outputPerMTok: 1, cachedInputPerMTok: 1 },
            },
          },
          routes: {
            routing: ['small'],
            simple: ['small'],
            reasoning: ['big'],
            sensitive: ['big'],
          },
        },
        'test',
      ),
      providers: [provider],
      recorder: new InMemoryUsageRecorder(),
      sleep: () => Promise.resolve(),
    });

    await gateway.complete({
      task: 'simple',
      messages: [userMessage('hi')],
      maxOutputTokens: 8000,
      attribution: { tenantId: 'tenant-1', sessionId: 'session-1' },
    });

    expect(provider.calls[0]?.request.maxOutputTokens).toBe(2000);
  });

  it('leaves the caller alone when the model declares none', async () => {
    const provider = new FakeProvider('groq', () => answer('ok'));
    const gateway = new RoutedGateway({
      config: parseModelConfig(
        {
          providers: {
            groq: { kind: 'openai-compatible', baseUrl: 'https://x.test/v1', apiKeyEnv: 'K' },
          },
          models: {
            big: {
              provider: 'groq',
              model: 'llama-versatile',
              tier: 'premium',
              price: { inputPerMTok: 1, outputPerMTok: 1, cachedInputPerMTok: 1 },
            },
          },
          routes: {
            routing: ['big'],
            simple: ['big'],
            reasoning: ['big'],
            sensitive: ['big'],
          },
        },
        'test',
      ),
      providers: [provider],
      recorder: new InMemoryUsageRecorder(),
      sleep: () => Promise.resolve(),
    });

    await gateway.complete({
      task: 'simple',
      messages: [userMessage('hi')],
      maxOutputTokens: 8000,
      attribution: { tenantId: 'tenant-1', sessionId: 'session-1' },
    });

    expect(provider.calls[0]?.request.maxOutputTokens).toBe(8000);
  });
});
