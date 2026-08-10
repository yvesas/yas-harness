// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Whose key embeds a tenant's documents.
 *
 * Shared knowledge was the last thing that could only be paid for with an
 * environment variable — which made the person running the harness hold a key
 * on everybody's behalf. These tests are about the two answers being kept
 * apart: the tenant's key when there is one, the platform's when there is not,
 * and a clear refusal when there is neither.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { EmbeddingError } from '../../src/memory/embedder.js';
import { KeyedEmbedderFactory } from '../../src/memory/keyed-embedder-factory.js';
import type { ModelKeys } from '../../src/models/model-keys.js';

const TENANT = 'tenant-1';
const ENTRY = {
  model: 'text-embedding-3-small',
  baseUrl: 'https://api.example.com/v1',
  provider: 'embedding',
  apiKeyEnv: 'EMBEDDING_MODEL_API_KEY',
};

/** Records the Authorization header a request went out with. */
function spyFetch() {
  const sent: string[] = [];
  const fetch: typeof globalThis.fetch = (_url, init) => {
    sent.push(String((init?.headers as Record<string, string>)?.['authorization']));
    return Promise.resolve(
      new Response(JSON.stringify({ data: [{ index: 0, embedding: new Array(1536).fill(0.1) }] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  return { sent, fetch };
}

function keys(overrides: Partial<ModelKeys> = {}): ModelKeys {
  return {
    providers: () => Promise.resolve([]),
    resolve: () => Promise.resolve(null),
    ...overrides,
  };
}

beforeEach(() => {
  delete process.env['EMBEDDING_MODEL_API_KEY'];
});

afterEach(() => {
  delete process.env['EMBEDDING_MODEL_API_KEY'];
});

describe('KeyedEmbedderFactory', () => {
  it('embeds on the tenant’s own key when they brought one', async () => {
    process.env['EMBEDDING_MODEL_API_KEY'] = 'platform-key';
    const { sent, fetch } = spyFetch();
    const factory = new KeyedEmbedderFactory({
      entry: ENTRY,
      modelKeys: keys({ resolve: () => Promise.resolve('tenant-key') }),
      fetch,
    });

    await (await factory.for(TENANT)).embed(['hello']);

    // Their key, not the platform's, even though the platform has one.
    expect(sent[0]).toBe('Bearer tenant-key');
  });

  it('falls back to the platform key when the tenant brought none', async () => {
    process.env['EMBEDDING_MODEL_API_KEY'] = 'platform-key';
    const { sent, fetch } = spyFetch();
    const factory = new KeyedEmbedderFactory({ entry: ENTRY, modelKeys: keys(), fetch });

    await (await factory.for(TENANT)).embed(['hello']);

    // Unlike completions, bringing no key is not opting out of anything: there
    // is one embedding provider, so there is nowhere else this could be routed.
    expect(sent[0]).toBe('Bearer platform-key');
  });

  it('sends somebody to the Keys page, not to a file, when the variable is empty', async () => {
    // The message that used to appear named only the environment variable,
    // which was right when a variable was the only way. Now it is the
    // fallback, and a message about it alone sends somebody to edit a file
    // when the answer is a form.
    const factory = new KeyedEmbedderFactory({ entry: ENTRY, modelKeys: keys() });

    await expect(factory.for(TENANT)).rejects.toThrow(
      /EMBEDDING_MODEL_API_KEY is not set either.*Keys page/s,
    );
  });

  it('says both ways out when there is no key anywhere', async () => {
    const factory = new KeyedEmbedderFactory({
      // A deployment that names no environment variable at all — which is the
      // point of the whole change: keys are not the deployment's to hold.
      entry: { ...ENTRY, apiKeyEnv: undefined },
      modelKeys: keys(),
    });

    await expect(factory.for(TENANT)).rejects.toThrow(
      /declared no environment variable.*Keys page/s,
    );
  });

  it('refuses rather than quietly billing the platform when unsealing fails', async () => {
    process.env['EMBEDDING_MODEL_API_KEY'] = 'platform-key';
    const factory = new KeyedEmbedderFactory({
      entry: ENTRY,
      modelKeys: keys({
        resolve: () => Promise.reject(new Error('the vault is unreachable')),
      }),
    });

    // Treating an unreadable key as "they have none" would embed their
    // documents on somebody else's account, which is what bringing a key was
    // meant to prevent.
    await expect(factory.for(TENANT)).rejects.toThrow(EmbeddingError);
  });

  it('does not let a tenant key change which model embeds', async () => {
    const { fetch } = spyFetch();
    const factory = new KeyedEmbedderFactory({
      entry: ENTRY,
      modelKeys: keys({ resolve: () => Promise.resolve('tenant-key') }),
      fetch,
    });

    // Vectors from two models are not comparable, so a key changes who pays and
    // never what embeds. The model name is read from the config for everybody.
    expect((await factory.for(TENANT)).model).toBe(ENTRY.model);
  });

  it('works with no key store at all, on the platform key', async () => {
    process.env['EMBEDDING_MODEL_API_KEY'] = 'platform-key';
    const { sent, fetch } = spyFetch();
    const factory = new KeyedEmbedderFactory({ entry: ENTRY, fetch });

    await (await factory.for(TENANT)).embed(['hello']);

    expect(sent[0]).toBe('Bearer platform-key');
  });
});
