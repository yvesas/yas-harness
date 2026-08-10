// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Bring your own model.
 *
 * The rule under test is one sentence — **bringing a key is opting out of the
 * platform's** — and most of these cases are about the ways a system gets that
 * subtly wrong: falling back to our key when theirs is missing, unsealing keys
 * nobody asked for, or billing a tenant for spend that was never ours.
 *
 * The dangerous failure here is the silent one. A tenant whose call quietly
 * lands on the platform's account gets exactly the answer they expected, and
 * finds out months later.
 */

import { describe, expect, it } from 'vitest';

import { EnvelopeCipher } from '../../src/connections/envelope-cipher.js';
import type { TenantKeyStore } from '../../src/connections/credential-vault.js';
import type { Sealed } from '../../src/connections/envelope-cipher.js';
import {
  InMemoryModelKeys,
  ModelKeyError,
  ModelKeyVault,
  type ModelKeyStore,
  type ModelKeys,
} from '../../src/models/model-keys.js';
import type { ModelResponse } from '../../src/models/model-gateway.js';
import { ModelGatewayError, userMessage } from '../../src/models/model-gateway.js';
import type { ModelProvider, ProviderCall } from '../../src/models/model-provider.js';
import { RoutedGateway } from '../../src/models/routed-gateway.js';
import { parseModelConfig } from '../../src/models/routing.js';
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
    // Declared so the tests below can tell a key that pays for turns from one
    // that pays for shared knowledge. Its provider name defaults to
    // "embedding".
    embedding: { model: 'embed-small', baseUrl: 'https://api.example.test/v1' },
    attemptsPerModel: 1,
  },
  'test',
);

class FakeProvider implements ModelProvider {
  readonly calls: ProviderCall[] = [];

  constructor(readonly name: string) {}

  invoke(call: ProviderCall): Promise<ModelResponse> {
    this.calls.push(call);
    return Promise.resolve({
      model: this.name,
      content: [{ type: 'text', text: 'hello' }],
      stopReason: 'end_turn',
      usage: { inputTokens: 10, outputTokens: 5, cachedInputTokens: 0 },
      latencyMs: 1,
    });
  }
}

function build(modelKeys?: ModelKeys) {
  const groq = new FakeProvider('groq');
  const anthropic = new FakeProvider('anthropic');
  const recorder = new InMemoryUsageRecorder();
  const gateway = new RoutedGateway({
    config,
    providers: [groq, anthropic],
    recorder,
    sleep: () => Promise.resolve(),
    ...(modelKeys ? { modelKeys } : {}),
  });
  return { gateway, groq, anthropic, recorder };
}

function request(task: 'simple' | 'reasoning' = 'simple') {
  return {
    task,
    messages: [userMessage('hi')],
    attribution: { tenantId: TENANT, sessionId: 'session-1' },
  } as const;
}

describe('bringing a key opts out of the platform key', () => {
  it('changes nothing for a tenant who brought none', async () => {
    const { gateway, groq, recorder } = build(new InMemoryModelKeys());

    await gateway.complete(request());

    // The whole posture before BYOM, unchanged: our key, first candidate.
    expect(groq.calls[0]?.apiKey).toBeUndefined();
    expect(recorder.records[0]?.billedTo).toBe('platform');
  });

  it('sends the tenant’s own key to the provider they have one for', async () => {
    const keys = new InMemoryModelKeys();
    keys.set(TENANT, 'groq', 'tenant-groq-key');
    const { gateway, groq } = build(keys);

    await gateway.complete(request());

    expect(groq.calls[0]?.apiKey).toBe('tenant-groq-key');
  });

  it('refuses rather than falling back to our key', async () => {
    const keys = new InMemoryModelKeys();
    keys.set(TENANT, 'groq', 'tenant-groq-key');
    const { gateway, anthropic } = build(keys);

    // `reasoning` routes only to anthropic, which this tenant has no key for.
    const failure = await gateway.complete(request('reasoning')).catch((error: unknown) => error);

    // The failure mode worth engineering against: falling back would send this
    // tenant's data to a provider they deliberately did not choose, and bill us
    // for it — and would look, from the outside, exactly like success.
    expect(anthropic.calls).toHaveLength(0);
    expect((failure as Error).message).toMatch(/brought their own model keys/);
  });

  it('says the tenant has no covered candidate, not that there are none', async () => {
    const keys = new InMemoryModelKeys();
    keys.set(TENANT, 'openai', 'a key for a provider we do not route to');
    const { gateway } = build(keys);

    const failure = await gateway.complete(request()).catch((error: unknown) => error);

    // "no candidates" would send an operator hunting for a routing bug; the
    // answer is a key this tenant has not added.
    expect((failure as Error).message).toMatch(/none of the 2 candidate\(s\)/);
  });

  it('skips a candidate the tenant has no key for and uses the one they do', async () => {
    const keys = new InMemoryModelKeys();
    keys.set(TENANT, 'anthropic', 'tenant-anthropic-key');
    const { gateway, groq, anthropic } = build(keys);

    // `simple` prefers groq; this tenant only covers anthropic.
    await gateway.complete(request());

    expect(groq.calls).toHaveLength(0);
    expect(anthropic.calls[0]?.apiKey).toBe('tenant-anthropic-key');
  });

  it('keeps one tenant’s key away from another', async () => {
    const keys = new InMemoryModelKeys();
    keys.set(TENANT, 'groq', 'tenant-1-key');
    const { gateway, groq } = build(keys);

    await gateway.complete(request());
    await gateway.complete({
      task: 'simple',
      messages: [userMessage('hi')],
      attribution: { tenantId: 'tenant-2' },
    });

    // The second tenant brought nothing, so they are on ours — not on the key
    // that happened to be resolved a moment earlier.
    expect(groq.calls.map((call) => call.apiKey)).toEqual(['tenant-1-key', undefined]);
  });

  it('only unseals the key for the provider actually called', async () => {
    const asked: string[] = [];
    const keys: ModelKeys = {
      providers: () => Promise.resolve(['groq', 'anthropic']),
      resolve: (_tenantId, provider) => {
        asked.push(provider);
        return Promise.resolve(`${provider}-key`);
      },
    };
    const { gateway } = build(keys);

    await gateway.complete(request());

    // Answering "which providers" must not cost a decryption per provider.
    expect(asked).toEqual(['groq']);
  });

  it('fails rather than guessing when the key store is unreachable', async () => {
    const keys: ModelKeys = {
      providers: () => Promise.reject(new Error('the vault is down')),
      resolve: () => Promise.resolve(null),
    };
    const { gateway, groq } = build(keys);

    const failure = await gateway.complete(request()).catch((error: unknown) => error);

    // A resolver being unreachable says nothing about what the tenant chose,
    // and "they have none" is the guess that spends our money.
    expect(groq.calls).toHaveLength(0);
    expect(failure).toBeInstanceOf(ModelGatewayError);
    expect((failure as Error).message).toMatch(/could not read the model keys/);
  });
});

describe('who paid is recorded', () => {
  it('bills a call on the tenant’s key to the tenant', async () => {
    const keys = new InMemoryModelKeys();
    keys.set(TENANT, 'groq', 'tenant-groq-key');
    const { gateway, recorder } = build(keys);

    await gateway.complete(request());

    // Cost is still recorded — what a call cost is worth knowing even when it
    // is not ours to charge for — but it must not be invoiced twice.
    expect(recorder.records[0]).toMatchObject({ billedTo: 'tenant' });
    expect(recorder.records[0]?.costUsd).toBeGreaterThan(0);
  });

  it('bills a tenant on our key to the platform', async () => {
    const { gateway, recorder } = build();

    await gateway.complete(request());

    expect(recorder.records[0]?.billedTo).toBe('platform');
  });
});

/** The tenant key store the vault seals against, in memory. */
function memoryStores() {
  const cipher = EnvelopeCipher.fromBase64(Buffer.alloc(32, 7).toString('base64'));
  const dek = cipher.newDataKey();
  const tenantKeys: TenantKeyStore = {
    ensure: () => Promise.resolve(dek.sealed),
    find: (tenantId) => Promise.resolve(tenantId === TENANT ? dek.sealed : null),
  };

  const rows = new Map<string, Sealed>();
  const store: ModelKeyStore = {
    put: (tenantId, provider, sealed) => {
      rows.set(`${tenantId}:${provider}`, sealed);
      return Promise.resolve();
    },
    get: (tenantId, provider) => Promise.resolve(rows.get(`${tenantId}:${provider}`) ?? null),
    delete: (tenantId, provider) => Promise.resolve(rows.delete(`${tenantId}:${provider}`)),
    providers: (tenantId) =>
      Promise.resolve(
        [...rows.keys()]
          .filter((key) => key.startsWith(`${tenantId}:`))
          .map((key) => key.slice(tenantId.length + 1)),
      ),
  };
  return { cipher, tenantKeys, store, rows };
}

describe('model keys are sealed like every other secret', () => {
  it('never stores a key readable', async () => {
    const { cipher, tenantKeys, store, rows } = memoryStores();
    const vault = new ModelKeyVault(cipher, tenantKeys, store);

    await vault.store(TENANT, 'anthropic', 'sk-ant-secret');

    // A database dump must not be a set of credentials.
    expect(rows.get(`${TENANT}:anthropic`)?.toString('utf8')).not.toContain('sk-ant-secret');
    expect(await vault.resolve(TENANT, 'anthropic')).toBe('sk-ant-secret');
  });

  it('answers "which providers" without unsealing anything', async () => {
    const { cipher, tenantKeys, store } = memoryStores();
    const vault = new ModelKeyVault(cipher, tenantKeys, store);
    await vault.store(TENANT, 'anthropic', 'sk-ant-secret');
    await vault.store(TENANT, 'groq', 'gsk-secret');

    expect(await vault.providers(TENANT)).toEqual(['anthropic', 'groq']);
  });

  it('returns null for a provider the tenant brought no key for', async () => {
    const { cipher, tenantKeys, store } = memoryStores();
    const vault = new ModelKeyVault(cipher, tenantKeys, store);

    expect(await vault.resolve(TENANT, 'groq')).toBeNull();
  });

  it('refuses an empty key at the door', async () => {
    const { cipher, tenantKeys, store } = memoryStores();
    const vault = new ModelKeyVault(cipher, tenantKeys, store);

    // Otherwise it seals, stores, and fails at the provider as an auth error —
    // three layers from the mistake.
    await expect(vault.store(TENANT, 'groq', '')).rejects.toBeInstanceOf(ModelKeyError);
  });

  it('does not touch the data key for a tenant who stored nothing', async () => {
    const { cipher, store } = memoryStores();
    let asked = 0;
    const counting: TenantKeyStore = {
      ensure: (_tenantId, sealed) => {
        asked += 1;
        return Promise.resolve(sealed);
      },
      find: () => {
        asked += 1;
        return Promise.resolve(null);
      },
    };

    // No sealed key means nothing to open, so the answer is null before any
    // question about data keys arises.
    expect(await new ModelKeyVault(cipher, counting, store).resolve('nobody', 'groq')).toBeNull();
    expect(asked).toBe(0);
  });

  it('creates the data key for a tenant whose first secret is a model key', async () => {
    const { cipher, store } = memoryStores();
    let created = 0;
    const empty: TenantKeyStore = {
      ensure: (_tenantId, sealed) => {
        created += 1;
        return Promise.resolve(sealed);
      },
      find: () => Promise.resolve(null),
    };
    const vault = new ModelKeyVault(cipher, empty, store);
    await vault.store('fresh-tenant', 'groq', 'gsk-secret');

    // BYOM must not require connecting a source first just to have somewhere
    // to hang a data key.
    expect(created).toBe(1);
    expect(await vault.resolve('fresh-tenant', 'groq')).toBe('gsk-secret');
  });

  it('refuses to open a key whose data key has gone missing', async () => {
    const { cipher, store } = memoryStores();
    const rows = store;
    const present: TenantKeyStore = {
      ensure: (_tenantId, sealed) => Promise.resolve(sealed),
      find: () => Promise.resolve(null),
    };
    // Seal with a working vault, then read with one whose key store lost it.
    const working = memoryStores();
    const sealer = new ModelKeyVault(working.cipher, working.tenantKeys, rows);
    await sealer.store(TENANT, 'groq', 'gsk-secret');

    // A broken store must say so, not mint a fresh key and fail at decryption
    // somewhere further along.
    await expect(new ModelKeyVault(cipher, present, rows).resolve(TENANT, 'groq')).rejects.toThrow(
      /no data key to open it/,
    );
  });

  it('forgets a key when a tenant takes it back', async () => {
    const { cipher, tenantKeys, store } = memoryStores();
    const vault = new ModelKeyVault(cipher, tenantKeys, store);
    await vault.store(TENANT, 'groq', 'gsk-secret');

    expect(await vault.forget(TENANT, 'groq')).toBe(true);
    expect(await vault.providers(TENANT)).toEqual([]);
    // And with the key gone, they are back on the platform's.
    expect(await vault.resolve(TENANT, 'groq')).toBeNull();
  });
});

describe('a key for something this gateway does not route to', () => {
  it('is not counted as bringing a key', async () => {
    // The embedding key is filed under its own provider name, because it pays
    // for shared knowledge rather than for turns. Counting it here would
    // filter every completion candidate away, and a tenant who paid only for
    // knowledge would find that no turn could run at all.
    const { gateway, groq } = build({
      providers: () => Promise.resolve(['embedding']),
      resolve: () => Promise.resolve(null),
    });

    const response = await gateway.complete(request());

    expect(response.content).toEqual([{ type: 'text', text: 'hello' }]);
    // On the platform key, as a tenant who brought no *completion* key should
    // be — and the provider was reached at all, which is the point.
    expect(groq.calls).toHaveLength(1);
    expect(groq.calls[0]?.apiKey).toBeUndefined();
  });
});
