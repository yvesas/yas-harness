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

import { fixedEmbedder, type Embedder } from '../../src/memory/embedder.js';
import type { DocumentInput } from '../../src/memory/memory-store.js';
import { RECENCY_FLOOR } from '../../src/memory/memory-store.js';
import { PostgresMemoryStore } from '../../src/memory/postgres-memory-store.js';

const DATABASE_URL = process.env['DATABASE_URL'];

/**
 * How wide the column actually is, asked of the database.
 *
 * Not a constant, because the width is a deployment's own choice now — it comes
 * from `embedding.dimensions` and differs per vendor. A number written here
 * would pass on the machine it was written on and fail on every other, which is
 * exactly what it did.
 *
 * Asking also earns something: a stub whose vectors fit proves the migration
 * substituted the declared number, which nothing else checks.
 */
async function columnDimensions(pool: pg.Pool): Promise<number> {
  const { rows } = await pool.query<{ dimensions: number }>(
    `SELECT atttypmod AS dimensions
       FROM pg_attribute
      WHERE attrelid = 'memory_chunks'::regclass AND attname = 'embedding'`,
  );
  return rows[0]!.dimensions;
}

/**
 * Vectors that make distance predictable.
 *
 * Each text gets a one-hot vector at a slot decided by its first character, so
 * "apple" and "avocado" are identical and "zebra" is orthogonal to both. Cosine
 * distance is then 0 or 1, and a ranking assertion is exact.
 */
function oneHot(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);
  vector[text.trim().toLowerCase().charCodeAt(0) % dimensions] = 1;
  return vector;
}

class StubEmbedder implements Embedder {
  readonly model = 'stub';
  calls = 0;

  constructor(readonly dimensions: number) {}

  embed(texts: readonly string[]): Promise<number[][]> {
    this.calls += 1;
    return Promise.resolve(texts.map((text) => oneHot(text, this.dimensions)));
  }
}

describe.skipIf(!DATABASE_URL)('PostgresMemoryStore', () => {
  let pool: pg.Pool;
  let embedder: StubEmbedder;
  let store: PostgresMemoryStore;
  let tenantA: string;
  let tenantB: string;
  let dimensions: number;

  beforeAll(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    dimensions = await columnDimensions(pool);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['mem-%']);
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM tenants WHERE slug LIKE $1', ['mem-%']);
    tenantA = await createTenant(pool, 'mem-a');
    tenantB = await createTenant(pool, 'mem-b');
    embedder = new StubEmbedder(dimensions);
    store = new PostgresMemoryStore(pool, fixedEmbedder(embedder));
  });

  async function seed(tenantId: string, slug = 'wiki') {
    const source = await store.createSource({ tenantId, slug, name: 'Wiki' });
    await store.ingest({
      tenantId,
      sourceId: source.id,
      provenance: 'owner',
      externalId: 'doc-a',
      title: 'Apples',
      body: 'apple orchards and how to keep them',
    });
    await store.ingest({
      tenantId,
      sourceId: source.id,
      provenance: 'owner',
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
    const document: DocumentInput = {
      tenantId: tenantA,
      sourceId: source.id,
      provenance: 'owner',
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
      provenance: 'owner',
      externalId: 'doc-a',
      title: 'Apples',
      body: 'apple orchards',
    });

    await store.ingest({
      tenantId: tenantA,
      sourceId: source.id,
      provenance: 'owner',
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

  it('hands provenance back with the passage, unchanged from what was written', async () => {
    const source = await store.createSource({ tenantId: tenantA, slug: 'wiki', name: 'Wiki' });
    await store.ingest({
      tenantId: tenantA,
      sourceId: source.id,
      provenance: 'untrusted',
      title: 'Apples',
      body: 'apple orchards',
    });

    const [hit] = await store.search(tenantA, { sourceIds: [source.id], text: 'apples' });

    // The point of recording it is that a caller can act on it; a value that
    // never leaves the table is a value nobody can weigh.
    expect(hit?.provenance).toBe('untrusted');
    expect(hit?.importance).toBe(5);
  });

  it('lets importance break a tie that distance cannot', async () => {
    const source = await store.createSource({ tenantId: tenantA, slug: 'wiki', name: 'Wiki' });
    // Both start with "a", so the stub embeds them identically: distance is 0
    // for each and the ceiling has nothing to say. Only importance differs.
    await store.ingest({
      tenantId: tenantA,
      sourceId: source.id,
      provenance: 'owner',
      externalId: 'minor',
      title: 'Aside',
      body: 'apple orchards, in passing',
      importance: 2,
    });
    await store.ingest({
      tenantId: tenantA,
      sourceId: source.id,
      provenance: 'owner',
      externalId: 'major',
      title: 'Reference',
      body: 'apple orchards, the standing guide',
      importance: 9,
    });

    const hits = await store.search(tenantA, { sourceIds: [source.id], text: 'apples' });

    expect(hits.map((hit) => hit.title)).toEqual(['Reference', 'Aside']);
    expect(hits[0]!.distance).toBe(hits[1]!.distance);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });

  it('lets age cost a passage at most half its score, never its place in the corpus', async () => {
    const source = await store.createSource({ tenantId: tenantA, slug: 'wiki', name: 'Wiki' });
    await store.ingest({
      tenantId: tenantA,
      sourceId: source.id,
      provenance: 'owner',
      externalId: 'ancient',
      title: 'Apples',
      body: 'apple orchards',
    });
    // Ten years is many half-lives: without the floor, the exponential would
    // have driven this to roughly zero and the document would be unreachable
    // however well it answers.
    await pool.query(
      `UPDATE memory_documents SET updated_at = now() - interval '10 years'
        WHERE tenant_id = $1 AND external_id = 'ancient'`,
      [tenantA],
    );

    const [hit] = await store.search(tenantA, { sourceIds: [source.id], text: 'apples' });

    expect(hit).toBeDefined();
    // distance 0 and importance 5 leave score = recency x 0.5, and recency
    // cannot fall below RECENCY_FLOOR.
    expect(hit!.score).toBeGreaterThanOrEqual(RECENCY_FLOOR * 0.5);
  });

  it('refuses an importance outside 1-10 rather than clamping it', async () => {
    const source = await store.createSource({ tenantId: tenantA, slug: 'wiki', name: 'Wiki' });
    const document: DocumentInput = {
      tenantId: tenantA,
      sourceId: source.id,
      provenance: 'owner',
      title: 'Apples',
      body: 'apple orchards',
    };

    await expect(store.ingest({ ...document, importance: 11 })).rejects.toThrow(/1 to 10/);
    await expect(store.ingest({ ...document, importance: 0 })).rejects.toThrow(/1 to 10/);
    await expect(store.ingest({ ...document, importance: 2.5 })).rejects.toThrow(/1 to 10/);
  });
});

async function createTenant(pool: pg.Pool, slug: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'INSERT INTO tenants (slug, name) VALUES ($1, $2) RETURNING id',
    [slug, slug],
  );
  return rows[0]!.id;
}
