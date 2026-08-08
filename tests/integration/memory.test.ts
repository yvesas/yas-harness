// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Shared knowledge against a real database.
 *
 * A vector search proven against a fake is not proven. What is being checked
 * here is pgvector actually ordering by cosine distance, the tenant boundary
 * holding on a query that joins three tables, and the checksum saving an
 * embedding call — which is the difference between re-ingesting a corpus for
 * free and paying for it twice.
 *
 * The embedder is a stub on purpose: deterministic vectors make "did it rank
 * these correctly" a question with one right answer, which a real embedding
 * model would turn into a judgement call.
 */

import pg from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { EMBEDDING_DIMENSIONS, type Embedder } from '../../src/memory/embedder.js';
import { PostgresMemoryStore } from '../../src/memory/postgres-memory-store.js';

const DATABASE_URL = process.env['DATABASE_URL'];

/**
 * Vectors that make distance predictable.
 *
 * Each text gets a one-hot vector at a slot decided by its first character, so
 * "apple" and "avocado" are identical and "zebra" is orthogonal to both. Cosine
 * distance is then 0 or 1, and a ranking assertion is exact.
 */
function oneHot(text: string): number[] {
  const vector = new Array<number>(EMBEDDING_DIMENSIONS).fill(0);
  vector[text.trim().toLowerCase().charCodeAt(0) % EMBEDDING_DIMENSIONS] = 1;
  return vector;
}

class StubEmbedder implements Embedder {
  readonly model = 'stub';
  calls = 0;

  embed(texts: readonly string[]): Promise<number[][]> {
    this.calls += 1;
    return Promise.resolve(texts.map(oneHot));
  }
}

describe.skipIf(!DATABASE_URL)('PostgresMemoryStore', () => {
  let pool: pg.Pool;
  let embedder: StubEmbedder;
  let store: PostgresMemoryStore;
  let tenantA: string;
  let tenantB: string;

  beforeAll(() => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
  });

  afterAll(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['mem-%']);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['mem-%']);
    tenantA = await createTenant(pool, 'mem-a');
    tenantB = await createTenant(pool, 'mem-b');
    embedder = new StubEmbedder();
    store = new PostgresMemoryStore(pool, embedder);
  });

  async function seed(tenantId: string, slug = 'wiki') {
    const source = await store.createSource({ tenantId, slug, name: 'Wiki' });
    await store.ingest({
      tenantId,
      sourceId: source.id,
      externalId: 'doc-a',
      title: 'Apples',
      body: 'apple orchards and how to keep them',
    });
    await store.ingest({
      tenantId,
      sourceId: source.id,
      externalId: 'doc-z',
      title: 'Zebras',
      body: 'zebra herds and where they graze',
    });
    return source;
  }

  it('finds the passage nearest the question, not merely a passage', async () => {
    const source = await seed(tenantA);

    const hits = await store.search(tenantA, { sourceIds: [source.id], text: 'apple' });

    expect(hits[0]?.title).toBe('Apples');
    expect(hits[0]?.distance).toBeCloseTo(0, 5);
  });

  it('returns nothing when the question is not in the corpus', async () => {
    const source = await seed(tenantA);

    // A vector search always has nearest neighbours, however far. Without the
    // distance ceiling, a question about nothing comes back with the least
    // irrelevant passage and a model treats it as an answer.
    const hits = await store.search(tenantA, { sourceIds: [source.id], text: 'quantum' });

    expect(hits).toEqual([]);
  });

  it('never reaches another tenant’s knowledge', async () => {
    const mine = await seed(tenantA);
    await seed(tenantB);

    // Searching with my own source id as tenant B must find nothing: the query
    // joins three tables, and the boundary has to survive all of them.
    expect(await store.search(tenantB, { sourceIds: [mine.id], text: 'apple' })).toEqual([]);
  });

  it('searches nothing when the agent was granted nothing', async () => {
    await seed(tenantA);

    expect(await store.search(tenantA, { sourceIds: [], text: 'apple' })).toEqual([]);
  });

  it('does not pay to embed a document that has not changed', async () => {
    const source = await store.createSource({ tenantId: tenantA, slug: 'wiki', name: 'Wiki' });
    const document = {
      tenantId: tenantA,
      sourceId: source.id,
      externalId: 'doc-a',
      title: 'Apples',
      body: 'apple orchards',
    };

    const first = await store.ingest(document);
    const calls = embedder.calls;
    const second = await store.ingest(document);

    expect(first.embedded).toBe(true);
    expect(second.embedded).toBe(false);
    expect(embedder.calls).toBe(calls);
    expect(second.document.id).toBe(first.document.id);
  });

  it('re-embeds when the body changed, and leaves no stale chunks', async () => {
    const source = await store.createSource({ tenantId: tenantA, slug: 'wiki', name: 'Wiki' });
    await store.ingest({
      tenantId: tenantA,
      sourceId: source.id,
      externalId: 'doc-a',
      title: 'Apples',
      body: 'apple orchards',
    });

    await store.ingest({
      tenantId: tenantA,
      sourceId: source.id,
      externalId: 'doc-a',
      title: 'Apples',
      body: 'zebra herds now, entirely rewritten',
    });

    // The old chunks must be gone, or the document is findable by what it used
    // to say.
    expect(await store.search(tenantA, { sourceIds: [source.id], text: 'apple' })).toEqual([]);
    expect(
      (await store.search(tenantA, { sourceIds: [source.id], text: 'zebra' })).length,
    ).toBeGreaterThan(0);
  });

  it('counts what a source holds without a query per document', async () => {
    await seed(tenantA);

    const [source] = await store.listSources(tenantA);

    expect(source?.documents).toBe(2);
  });

  it('takes the whole source away with its documents and chunks', async () => {
    const source = await seed(tenantA);

    expect(await store.deleteSource(tenantA, source.id)).toBe(true);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM memory_chunks WHERE tenant_id = $1',
      [tenantA],
    );
    // Cascading, so knowledge cannot outlive the source it belonged to.
    expect(Number(rows[0]?.count)).toBe(0);
  });

  it('erases everything with the tenant', async () => {
    await seed(tenantA);

    await pool.query('DELETE FROM tenants WHERE id = $1', [tenantA]);

    const { rows } = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM memory_documents WHERE tenant_id = $1',
      [tenantA],
    );
    expect(Number(rows[0]?.count)).toBe(0);
  });
});

async function createTenant(pool: pg.Pool, slug: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
    [slug, slug],
  );
  return rows[0]!.id;
}
