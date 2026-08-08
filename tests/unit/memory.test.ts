// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared knowledge: the pieces that do not need a database.
 *
 * Chunking, the embedding adapter, and the grant that turns a source into a
 * tool. The store itself is exercised against real Postgres in
 * `tests/integration/memory.test.ts` — a vector search proven against a fake is
 * not proven at all.
 */

import { describe, expect, it } from 'vitest';

import { parseAgentConfig } from '../../src/agents/agent-config.js';
import { declaredAgent } from '../../src/agents/declared-agent.js';
import type { ConnectionOperations } from '../../src/connections/cached-connections.js';
import type { ConnectionStore } from '../../src/connections/connection-store.js';
import { chunk } from '../../src/memory/chunking.js';
import {
  assertDimensions,
  EMBEDDING_DIMENSIONS,
  EmbeddingError,
} from '../../src/memory/embedder.js';
import { OpenAiCompatibleEmbedder } from '../../src/memory/openai-compatible-embedder.js';
import type { MemoryStore, SearchHit } from '../../src/memory/memory-store.js';

const BASE = {
  id: 'research',
  name: 'Research',
  description: 'Answers from the shared knowledge.',
  instructions: 'Answer from what you found.',
};

const CONTEXT = { tenantId: 'tenant-1', sessionId: 'session-1' };

describe('cutting a document into chunks', () => {
  it('leaves a short document whole', () => {
    expect(chunk('One paragraph, and not a long one.')).toEqual([
      'One paragraph, and not a long one.',
    ]);
  });

  it('says nothing about an empty document', () => {
    expect(chunk('   \n\n  ')).toEqual([]);
  });

  it('splits on the author’s paragraphs rather than a character count', () => {
    const paragraphs = ['A'.repeat(700), 'B'.repeat(700), 'C'.repeat(700)].join('\n\n');

    const pieces = chunk(paragraphs, { size: 1000, overlap: 0 });

    // A boundary the author chose is almost always better than one arithmetic
    // chose, so no chunk should contain the tail of one paragraph and the head
    // of another where a paragraph break was available.
    expect(pieces.length).toBeGreaterThan(1);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(1000);
    }
  });

  it('carries a tail forward, so a passage split across a boundary is findable', () => {
    const text = `${'first '.repeat(120)}\n\n${'second '.repeat(120)}`;

    const pieces = chunk(text, { size: 400, overlap: 100 });

    // Without overlap, a sentence spanning the boundary belongs to neither
    // chunk and is findable from neither.
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces[1]).toContain('first');
  });

  it('cuts text that has neither paragraphs nor sentences', () => {
    const wall = 'x'.repeat(5000);

    const pieces = chunk(wall, { size: 500, overlap: 0 });

    // A minified file, or a language this regex does not punctuate. Cut it
    // rather than refuse it.
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.every((piece) => piece.length <= 500)).toBe(true);
  });
});

describe('the embedding dimension is part of the schema', () => {
  it('rejects a model whose output is the wrong size, naming the fix', () => {
    // The database would reject it too, and the message would be about a
    // column. This one is about the model, which is the thing to change.
    expect(() => {
      assertDimensions('some-model', [[1, 2, 3]]);
    }).toThrow(/some-model.*3 dimensions.*migration 0012/s);
  });

  it('accepts one of the right size', () => {
    expect(() => {
      assertDimensions('good', [new Array<number>(EMBEDDING_DIMENSIONS).fill(0)]);
    }).not.toThrow();
  });
});

/** An embeddings endpoint the test scripts. */
function endpoint(answer: (input: string[]) => unknown) {
  const requests: string[][] = [];
  const stub = ((_url: string, init: RequestInit) => {
    const body = JSON.parse(init.body as string) as { input: string[] };
    requests.push(body.input);
    return Promise.resolve(
      new Response(JSON.stringify(answer(body.input)), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  }) as unknown as typeof fetch;
  return { stub, requests };
}

function vector(seed: number): number[] {
  return new Array<number>(EMBEDDING_DIMENSIONS).fill(seed);
}

describe('the embedding adapter', () => {
  it('batches instead of sending one request per chunk', async () => {
    const { stub, requests } = endpoint((input) => ({
      data: input.map((_text, index) => ({ index, embedding: vector(index) })),
    }));
    const embedder = new OpenAiCompatibleEmbedder({
      model: 'test',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'k',
      batchSize: 2,
      fetch: stub,
    });

    const vectors = await embedder.embed(['a', 'b', 'c']);

    expect(requests).toEqual([['a', 'b'], ['c']]);
    expect(vectors).toHaveLength(3);
  });

  it('puts a provider’s out-of-order answer back in order', async () => {
    const { stub } = endpoint((input) => ({
      // Reversed, with the index each one belongs at.
      data: input.map((_text, index) => ({ index, embedding: vector(index) })).reverse(),
    }));
    const embedder = new OpenAiCompatibleEmbedder({
      model: 'test',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'k',
      fetch: stub,
    });

    const vectors = await embedder.embed(['a', 'b']);

    // Callers pair by position, so an adapter that trusted arrival order would
    // attach every vector to the wrong chunk.
    expect(vectors[0]?.[0]).toBe(0);
    expect(vectors[1]?.[0]).toBe(1);
  });

  it('refuses a short answer rather than mispairing the rest', async () => {
    const { stub } = endpoint(() => ({ data: [{ index: 0, embedding: vector(0) }] }));
    const embedder = new OpenAiCompatibleEmbedder({
      model: 'test',
      baseUrl: 'https://api.example.test/v1',
      apiKey: 'k',
      fetch: stub,
    });

    await expect(embedder.embed(['a', 'b'])).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('names the variable a deployment chose when the key is missing', () => {
    expect(
      () =>
        new OpenAiCompatibleEmbedder({
          model: 'test',
          baseUrl: 'https://api.example.test/v1',
          apiKeyEnv: 'WHATEVER_WE_CALL_IT',
        }),
    ).toThrow(/WHATEVER_WE_CALL_IT/);
  });
});

/** A memory store the test drives, recording what it was asked. */
function store(hits: SearchHit[] = [], slugs: string[] = ['wiki']) {
  const searches: { sourceIds: readonly string[]; text: string }[] = [];
  const memory = {
    findSourceBySlug: (_tenantId: string, slug: string) =>
      Promise.resolve(slugs.includes(slug) ? { id: `id-${slug}`, slug } : null),
    search: (_tenantId: string, query: { sourceIds: readonly string[]; text: string }) => {
      searches.push(query);
      return Promise.resolve(hits);
    },
  } as unknown as MemoryStore;
  return { memory, searches };
}

const deps = {
  operations: {} as unknown as ConnectionOperations,
  connections: { list: () => Promise.resolve([]) } as unknown as ConnectionStore,
};

describe('a memory grant becomes a tool', () => {
  it('gives no memory tool to an agent granted nothing', () => {
    const config = parseAgentConfig(BASE, 'test');

    const names = declaredAgent(config, { ...deps, memory: store().memory })
      .tools.list()
      .map((tool) => tool.name);

    // Empty means it searches nothing. It does not mean everything.
    expect(names).not.toContain('memory_search');
  });

  it('gives no memory tool when the deployment cannot embed', () => {
    const config = parseAgentConfig({ ...BASE, memory: ['wiki'] }, 'test');

    // A granted source it could never search would be worse than no grant.
    expect(
      declaredAgent(config, deps)
        .tools.list()
        .map((tool) => tool.name),
    ).not.toContain('memory_search');
  });

  it('searches only the sources it was granted', async () => {
    const config = parseAgentConfig({ ...BASE, memory: ['wiki'] }, 'test');
    const { memory, searches } = store([], ['wiki', 'private-notes']);

    await declaredAgent(config, { ...deps, memory }).tools.execute(
      'memory_search',
      { query: 'anything' },
      CONTEXT,
    );

    expect(searches[0]?.sourceIds).toEqual(['id-wiki']);
  });

  it('resolves slugs at call time, so a grant never goes stale', async () => {
    const config = parseAgentConfig({ ...BASE, memory: ['not-created-yet'] }, 'test');
    const { memory } = store([], []);

    const result = await declaredAgent(config, { ...deps, memory }).tools.execute(
      'memory_search',
      { query: 'anything' },
      CONTEXT,
    );

    // A grant may legitimately precede the source. Failing would turn a typo in
    // a config file into an agent that cannot answer anything.
    expect(result.isError).toBe(false);
    expect(result.content).toMatch(/No knowledge sources are available/);
  });

  it('tells the model plainly when nothing matched', async () => {
    const config = parseAgentConfig({ ...BASE, memory: ['wiki'] }, 'test');

    const result = await declaredAgent(config, { ...deps, memory: store([]).memory }).tools.execute(
      'memory_search',
      { query: 'anything' },
      CONTEXT,
    );

    // The failure to avoid is a model reading "no results" as licence to
    // invent one.
    expect(result.content).toMatch(/Say so rather than guessing/);
  });

  it('hands back each passage with where it came from', async () => {
    const config = parseAgentConfig({ ...BASE, memory: ['wiki'] }, 'test');
    const { memory } = store([
      {
        documentId: 'd1',
        sourceSlug: 'wiki',
        title: 'Onboarding',
        url: 'https://wiki.test/1',
        text: 'the passage',
        distance: 0.1,
      },
    ]);

    const result = await declaredAgent(config, { ...deps, memory }).tools.execute(
      'memory_search',
      { query: 'anything' },
      CONTEXT,
    );

    expect(result.content).toContain('Onboarding');
    expect(result.content).toContain('https://wiki.test/1');
    expect(result.content).toContain('the passage');
  });
});
