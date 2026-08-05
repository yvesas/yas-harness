// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * The gateway remembers what is broken.
 *
 * Retry and fallback already worked; what they lacked was memory, so every
 * request rediscovered the same outage and paid the same timeouts to learn it.
 * These tests are about what the *second* request does — and about charging a
 * failure to whoever it belongs to, since a provider being down is everyone's
 * problem and a rate limit is one key's.
 *
 * The clock is injected, so cooldowns are exercised without waiting for them.
 */

import { describe, expect, it } from 'vitest';

import { InMemoryAvailability } from '../../src/models/availability.js';
import type { ModelRequest, ModelResponse } from '../../src/models/model-gateway.js';
import { ModelGatewayError, userMessage } from '../../src/models/model-gateway.js';
import type { ModelProvider, ProviderCall } from '../../src/models/model-provider.js';
import { RoutedGateway } from '../../src/models/routed-gateway.js';
import { parseModelConfig } from '../../src/models/routing.js';

const TENANT = 'tenant-1';
const OTHER_TENANT = 'tenant-2';

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

class FakeProvider implements ModelProvider {
  readonly calls: ProviderCall[] = [];

  constructor(
    readonly name: string,
    private readonly behaviour: () => ModelResponse | Error,
  ) {}

  invoke(call: ProviderCall): Promise<ModelResponse> {
    this.calls.push(call);
    const outcome = this.behaviour();
    return outcome instanceof Error ? Promise.reject(outcome) : Promise.resolve(outcome);
  }
}

function answer(text: string): ModelResponse {
  return {
    model: text,
    content: [{ type: 'text', text }],
    stopReason: 'end_turn',
    usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: 0 },
    latencyMs: 1,
  };
}

function outage(provider: string): ModelGatewayError {
  return new ModelGatewayError(`${provider} is down`, {
    provider,
    task: 'simple',
    retryable: true,
    kind: 'provider',
  });
}

function rateLimited(provider: string, retryAfterMs?: number): ModelGatewayError {
  return new ModelGatewayError(`${provider} rate limited`, {
    provider,
    task: 'simple',
    retryable: true,
    kind: 'credential',
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });
}

function request(tenantId = TENANT): ModelRequest {
  return {
    task: 'simple',
    messages: [userMessage('hello')],
    attribution: { tenantId, sessionId: 'session-1' },
  };
}

/** A clock the test moves by hand. */
function clock(start = new Date('2026-08-03T12:00:00Z')) {
  let at = start;
  return {
    now: () => at,
    advance(ms: number) {
      at = new Date(at.getTime() + ms);
    },
  };
}

function build(providers: ModelProvider[], time = clock(), cooldownMs = 15_000) {
  const availability = new InMemoryAvailability({ cooldownMs, faultsBeforeSkipping: 3 });
  const gateway = new RoutedGateway({
    config,
    providers,
    availability,
    now: time.now,
    sleep: () => Promise.resolve(),
  });
  return { gateway, time };
}

describe('gateway availability', () => {
  it('stops calling a provider that keeps failing', async () => {
    const groq = new FakeProvider('groq', () => outage('groq'));
    const anthropic = new FakeProvider('anthropic', () => answer('from-anthropic'));
    const { gateway } = build([groq, anthropic]);

    // Two attempts on the first request, one more on the second: the third
    // consecutive fault trips it.
    await gateway.complete(request());
    await gateway.complete(request());
    const callsBefore = groq.calls.length;
    await gateway.complete(request());

    // The third request never touched groq — it went straight to the fallback.
    expect(groq.calls.length).toBe(callsBefore);
    expect(anthropic.calls).toHaveLength(3);
  });

  it('lets exactly one request through once the cooldown passes', async () => {
    const groq = new FakeProvider('groq', () => outage('groq'));
    const anthropic = new FakeProvider('anthropic', () => answer('ok'));
    const { gateway, time } = build([groq, anthropic]);

    await gateway.complete(request());
    await gateway.complete(request());
    const tripped = groq.calls.length;

    await gateway.complete(request());
    expect(groq.calls.length).toBe(tripped); // skipped

    time.advance(15_000);
    await gateway.complete(request());

    // One probe, and only one: a still-broken provider costs a request per
    // cooldown, not every request.
    expect(groq.calls.length).toBe(tripped + 1);
    await gateway.complete(request());
    expect(groq.calls.length).toBe(tripped + 1);
  });

  it('forgets the outage as soon as a probe succeeds', async () => {
    let healthy = false;
    const groq = new FakeProvider('groq', () => (healthy ? answer('recovered') : outage('groq')));
    const anthropic = new FakeProvider('anthropic', () => answer('fallback'));
    const { gateway, time } = build([groq, anthropic]);

    await gateway.complete(request());
    await gateway.complete(request());

    healthy = true;
    time.advance(15_000);
    expect((await gateway.complete(request())).model).toBe('recovered');

    // Memory cleared: the next request goes straight back to the first choice.
    const before = groq.calls.length;
    expect((await gateway.complete(request())).model).toBe('recovered');
    expect(groq.calls.length).toBe(before + 1);
  });

  it('waits longer after a probe fails', async () => {
    const groq = new FakeProvider('groq', () => outage('groq'));
    const anthropic = new FakeProvider('anthropic', () => answer('ok'));
    const { gateway, time } = build([groq, anthropic]);

    await gateway.complete(request());
    await gateway.complete(request());
    time.advance(15_000);
    await gateway.complete(request()); // probe, fails → cooldown doubles

    const afterProbe = groq.calls.length;
    time.advance(15_000);
    await gateway.complete(request());
    // Still skipped: the second cooldown is 30s, not 15s.
    expect(groq.calls.length).toBe(afterProbe);

    time.advance(15_000);
    await gateway.complete(request());
    expect(groq.calls.length).toBe(afterProbe + 1);
  });

  it('does not retry the same model after a rate limit', async () => {
    const groq = new FakeProvider('groq', () => rateLimited('groq'));
    const anthropic = new FakeProvider('anthropic', () => answer('ok'));
    const { gateway } = build([groq, anthropic]);

    await gateway.complete(request());

    // One call, not two: the key is still over its limit a moment later, so a
    // second attempt spends a retry to learn nothing.
    expect(groq.calls).toHaveLength(1);
  });

  it('holds a rate limit against the tenant, not the provider', async () => {
    const groq = new FakeProvider('groq', () => rateLimited('groq'));
    const anthropic = new FakeProvider('anthropic', () => answer('ok'));
    const { gateway } = build([groq, anthropic]);

    await gateway.complete(request(TENANT));
    const afterFirst = groq.calls.length;
    await gateway.complete(request(OTHER_TENANT));

    // Another tenant's key is a different key — especially under BYOM — so it
    // must still get its own chance.
    expect(groq.calls.length).toBe(afterFirst + 1);
  });

  it('honours the provider’s own Retry-After over its own cooldown', async () => {
    const groq = new FakeProvider('groq', () => rateLimited('groq', 60_000));
    const anthropic = new FakeProvider('anthropic', () => answer('ok'));
    const { gateway, time } = build([groq, anthropic]);

    await gateway.complete(request());
    const tripped = groq.calls.length;

    // The computed cooldown would have been 15s; the provider said 60s, and it
    // knows when its own window resets.
    time.advance(15_000);
    await gateway.complete(request());
    expect(groq.calls.length).toBe(tripped);

    time.advance(45_000);
    await gateway.complete(request());
    expect(groq.calls.length).toBe(tripped + 1);
  });

  it('says what it skipped, and until when, when nothing is left', async () => {
    const groq = new FakeProvider('groq', () => outage('groq'));
    const anthropic = new FakeProvider('anthropic', () => outage('anthropic'));
    const { gateway } = build([groq, anthropic]);

    await gateway.complete(request()).catch(() => undefined);
    await gateway.complete(request()).catch(() => undefined);

    const failure = await gateway.complete(request()).catch((error: unknown) => error);

    // "no candidates" would send an operator hunting for a routing bug when
    // the answer is that everything is in cooldown, and until when.
    expect((failure as Error).message).toMatch(/skipped provider:groq until .*provider:anthropic/s);
  });

  it('leaves a rejected request alone — it is nobody’s outage', async () => {
    const permanent = new ModelGatewayError('invalid request', {
      provider: 'groq',
      task: 'simple',
      retryable: false,
    });
    const groq = new FakeProvider('groq', () => permanent);
    const anthropic = new FakeProvider('anthropic', () => answer('ok'));
    const { gateway } = build([groq, anthropic]);

    for (let i = 0; i < 5; i += 1) {
      await gateway.complete(request()).catch(() => undefined);
    }

    // Five rejections and the provider is still tried: a bad request says
    // nothing about the provider's health, and tripping on it would take a
    // healthy provider out of service.
    expect(groq.calls).toHaveLength(5);
  });
});
