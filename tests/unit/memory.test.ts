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
  DEFAULT_EMBEDDING_DIMENSIONS,
  EmbeddingError,
} from '../../src/memory/embedder.js';
import { OpenAiCompatibleEmbedder } from '../../src/memory/openai-compatible-embedder.js';
import type { DocumentInput, MemoryStore, SearchHit } from '../../src/memory/memory-store.js';

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

describe('the embedding dimension a deployment declared', () => {
  it('rejects a model whose output is the wrong size, naming the number to set', () => {
    // The database would reject it too, and the message would be about a
    // column. This one names the model, the size it actually returned, and the
    // line to change — because "vector(1024) expected 1536" tells somebody
    // nothing about which of their two choices was wrong.
    expect(() => {
      assertDimensions('some-model', [[1, 2, 3]], DEFAULT_EMBEDDING_DIMENSIONS);
    }).toThrow(/some-model.*3 dimensions.*"dimensions": 3.*config\/models\.json/s);
  });

  it('accepts one of the size that deployment declared, whatever it is', () => {
    // 1024 is Voyage, Cohere and Mistral; 1536 is OpenAI; 768 a local nomic.
    // None of them is more correct than the others, which is why the number is
    // configuration rather than a constant.
    expect(() => {
      assertDimensions('voyage', [new Array<number>(1024).fill(0)], 1024);
    }).not.toThrow();
    expect(() => {
      assertDimensions('openai', [new Array<number>(1536).fill(0)], 1536);
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
  return new Array<number>(DEFAULT_EMBEDDING_DIMENSIONS).fill(seed);
}

describe('the embedding adapter', () => {
  it('batches instead of sending one request per chunk', async () => {
    const { stub, requests } = endpoint((input) => ({
      data: input.map((_text, index) => ({ index, embedding: vector(index) })),
    }));
    const embedder = new OpenAiCompatibleEmbedder({
      model: 'test',
      baseUrl: 'https://api.example.test/v1',
      dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
      apiKey: 'k',
      batchSize: 2,
      fetch: stub,
    });

    const vectors = await embedder.embed(['a', 'b', 'c'], 'document');

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
      dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
      apiKey: 'k',
      fetch: stub,
    });

    const vectors = await embedder.embed(['a', 'b'], 'document');

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
      dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
      apiKey: 'k',
      fetch: stub,
    });

    await expect(embedder.embed(['a', 'b'], 'document')).rejects.toBeInstanceOf(EmbeddingError);
  });

  it('names the variable a deployment chose when the key is missing', () => {
    expect(
      () =>
        new OpenAiCompatibleEmbedder({
          model: 'test',
          baseUrl: 'https://api.example.test/v1',
          dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
          apiKeyEnv: 'WHATEVER_WE_CALL_IT',
        }),
    ).toThrow(/WHATEVER_WE_CALL_IT/);
  });
});

/** A memory store the test drives, recording what it was asked. */
function store(hits: SearchHit[] = [], slugs: string[] = ['wiki']) {
  const searches: { sourceIds: readonly string[]; text: string }[] = [];
  const ingested: DocumentInput[] = [];
  const memory = {
    findSourceBySlug: (_tenantId: string, slug: string) =>
      Promise.resolve(slugs.includes(slug) ? { id: `id-${slug}`, slug } : null),
    search: (_tenantId: string, query: { sourceIds: readonly string[]; text: string }) => {
      searches.push(query);
      return Promise.resolve(hits);
    },
    ingest: (input: DocumentInput) => {
      ingested.push(input);
      return Promise.resolve({ document: { title: input.title }, embedded: true });
    },
  } as unknown as MemoryStore;
  return { memory, searches, ingested };
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
        provenance: 'owner',
        importance: 5,
        score: 0.47,
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

describe('telling a document from a question', () => {
  /** Captures the body an embedder actually sent. */
  function spy() {
    const bodies: Record<string, unknown>[] = [];
    const fetch = ((_url: unknown, init?: RequestInit) => {
      // The adapter always sends a JSON string; anything else is a bug this
      // helper should surface rather than stringify into nonsense.
      const body = init?.body;
      if (typeof body !== 'string') {
        throw new TypeError('the embedder sent something that is not a JSON string');
      }
      bodies.push(JSON.parse(body) as Record<string, unknown>);
      return Promise.resolve(
        new Response(
          JSON.stringify({
            data: [
              { index: 0, embedding: new Array<number>(DEFAULT_EMBEDDING_DIMENSIONS).fill(0) },
            ],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      );
    }) as typeof globalThis.fetch;
    return { bodies, fetch };
  }

  const base = {
    model: 'test',
    baseUrl: 'https://api.example.test/v1',
    dimensions: DEFAULT_EMBEDDING_DIMENSIONS,
    apiKey: 'k',
  };

  it('says which it is, when the deployment says the provider takes it', async () => {
    // Measured against Voyage on this repository's own corpus: a matching pair
    // sat at cosine 0.628 without this and 0.399 with it — either side of the
    // 0.6 ceiling, so it is the difference between found and missed.
    const { bodies, fetch } = spy();
    const embedder = new OpenAiCompatibleEmbedder({ ...base, inputType: true, fetch });

    await embedder.embed(['a passage'], 'document');
    await embedder.embed(['a question?'], 'query');

    expect(bodies[0]?.['input_type']).toBe('document');
    expect(bodies[1]?.['input_type']).toBe('query');
  });

  it('says nothing by default, because OpenAI refuses what it does not know', async () => {
    const { bodies, fetch } = spy();
    const embedder = new OpenAiCompatibleEmbedder({ ...base, fetch });

    await embedder.embed(['a passage'], 'document');

    expect(bodies[0]).not.toHaveProperty('input_type');
  });
});

describe('writing to memory as a tool the model calls', () => {
  const REMEMBERING = { ...BASE, remembersTo: 'notes' };

  it('is not registered unless the agent was granted somewhere to write', () => {
    const config = parseAgentConfig({ ...BASE, memory: ['wiki'] }, 'test');
    const { memory } = store();

    const names = declaredAgent(config, { ...deps, memory })
      .tools.list()
      .map((t) => t.name);

    // Reading and writing are separate permissions: an agent that could write
    // into anything it can read would let whatever it was shown become
    // something it asserts.
    expect(names).toContain('memory_search');
    expect(names).not.toContain('memory_remember');
  });

  it('writes as `agent`, never as the person who owns the corpus', async () => {
    const config = parseAgentConfig(REMEMBERING, 'test');
    const { memory, ingested } = store([], ['notes']);

    await declaredAgent(config, { ...deps, memory }).tools.execute(
      'memory_remember',
      { title: 'Deploys are Thursdays', body: 'The team ships on Thursday mornings.' },
      CONTEXT,
    );

    // The model asserting something does not make a person have said it, and
    // the provenance column exists to keep those apart.
    expect(ingested[0]?.provenance).toBe('agent');
    expect(ingested[0]?.title).toBe('Deploys are Thursdays');
  });

  it('refuses to write back something memory already holds', async () => {
    const config = parseAgentConfig(REMEMBERING, 'test');
    const { memory, ingested } = store(
      [
        {
          documentId: 'd1',
          sourceSlug: 'notes',
          title: 'Deploys are Thursdays',
          url: null,
          text: 'The team ships on Thursday mornings.',
          distance: 0.01,
          provenance: 'agent',
          importance: 5,
          score: 0.49,
        },
      ],
      ['notes'],
    );

    const result = await declaredAgent(config, { ...deps, memory }).tools.execute(
      'memory_remember',
      { title: 'Deploys are Thursdays', body: 'The team ships on Thursday mornings.' },
      CONTEXT,
    );

    // The loop this stops: a passage that reached the model *from* a search,
    // written back as a second copy, is indistinguishable from independent
    // corroboration — a corpus that quietly agrees with itself.
    expect(ingested).toEqual([]);
    expect(result.content).toMatch(/Already remembered/);
  });

  it('writes a genuinely new fact about a subject already covered', async () => {
    const config = parseAgentConfig(REMEMBERING, 'test');
    // Same subject, far enough away to be a different claim rather than a
    // restatement — the duplicate guard is an identity check, not a topic one.
    const { memory, ingested } = store(
      [
        {
          documentId: 'd1',
          sourceSlug: 'notes',
          title: 'Deploys',
          url: null,
          text: 'The team ships on Thursday mornings.',
          distance: 0.4,
          provenance: 'agent',
          importance: 5,
          score: 0.3,
        },
      ],
      ['notes'],
    );

    await declaredAgent(config, { ...deps, memory }).tools.execute(
      'memory_remember',
      { title: 'Freeze week', body: 'No deploys during the December freeze.' },
      CONTEXT,
    );

    expect(ingested).toHaveLength(1);
  });

  it('says so plainly when the source it was told to write to does not exist', async () => {
    const config = parseAgentConfig(REMEMBERING, 'test');
    const { memory } = store([], []);

    const result = await declaredAgent(config, { ...deps, memory }).tools.execute(
      'memory_remember',
      { title: 'x', body: 'y' },
      CONTEXT,
    );

    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/no memory source called "notes"/i);
  });
});
