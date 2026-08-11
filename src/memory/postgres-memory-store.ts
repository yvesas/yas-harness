// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Adapter: shared knowledge in PostgreSQL, with pgvector doing the search.
 *
 * The extension has been in migration 0001 since the beginning, with a comment
 * saying it was for RAG, and nothing used it until now.
 *
 * Two things here are about not spending money twice. A document whose body has
 * not changed is not re-embedded — the checksum decides, and embedding is the
 * expensive part. And chunks are replaced in one transaction with the document
 * row, so a failure half way leaves the old chunks rather than a document with
 * none, which would be a document that exists and cannot be found.
 */

import type { Pool, PoolClient } from 'pg';
import { createHash } from 'node:crypto';

import { chunk, type ChunkOptions } from './chunking.js';
import { assertDimensions, type EmbedderFactory } from './embedder.js';
import {
  DEFAULT_MAX_DISTANCE,
  DEFAULT_SEARCH_LIMIT,
  MemoryError,
  type CreateSourceInput,
  type DocumentInput,
  type IngestOutcome,
  type MemorySource,
  type MemoryStore,
  type SearchHit,
  type SearchQuery,
  type StoredDocument,
} from './memory-store.js';

interface SourceRow {
  id: string;
  tenant_id: string;
  slug: string;
  name: string;
  description: string | null;
  kind: 'manual' | 'connection';
  connection_id: string | null;
  documents: string;
  created_at: Date;
  updated_at: Date;
}

interface DocumentRow {
  id: string;
  source_id: string;
  title: string;
  url: string | null;
  chunks: string;
  updated_at: Date;
}

/** pgvector reads a vector from `[1,2,3]`, not from a JSON array of strings. */
function toVector(values: readonly number[]): string {
  return `[${values.join(',')}]`;
}

export class PostgresMemoryStore implements MemoryStore {
  readonly #pool: Pool;
  readonly #embedders: EmbedderFactory;
  readonly #chunking: ChunkOptions;

  /**
   * A factory rather than an embedder, because whose key pays is a per-tenant
   * question and this store is handed the tenant on every call that embeds.
   */
  constructor(pool: Pool, embedders: EmbedderFactory, chunking: ChunkOptions = {}) {
    this.#pool = pool;
    this.#embedders = embedders;
    this.#chunking = chunking;
  }

  async createSource(input: CreateSourceInput): Promise<MemorySource> {
    const { rows } = await this.#pool.query<SourceRow>(
      `INSERT INTO memory_sources (tenant_id, slug, name, description, kind, connection_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (tenant_id, slug)
       DO UPDATE SET name = excluded.name,
                     description = excluded.description,
                     updated_at = now()
       RETURNING *, 0::text AS documents`,
      [
        input.tenantId,
        input.slug,
        input.name,
        input.description ?? null,
        input.kind ?? 'manual',
        input.connectionId ?? null,
      ],
    );
    return toSource(rows[0]!);
  }

  async listSources(tenantId: string): Promise<MemorySource[]> {
    const { rows } = await this.#pool.query<SourceRow>(
      // The count comes from a join rather than a query per source: a list of
      // ten sources must not be eleven round trips.
      `SELECT s.*, count(d.id)::text AS documents
         FROM memory_sources s
         LEFT JOIN memory_documents d ON d.source_id = s.id AND d.tenant_id = s.tenant_id
        WHERE s.tenant_id = $1
        GROUP BY s.id
        ORDER BY s.name`,
      [tenantId],
    );
    return rows.map(toSource);
  }

  async findSourceBySlug(tenantId: string, slug: string): Promise<MemorySource | null> {
    const { rows } = await this.#pool.query<SourceRow>(
      `SELECT s.*, count(d.id)::text AS documents
         FROM memory_sources s
         LEFT JOIN memory_documents d ON d.source_id = s.id AND d.tenant_id = s.tenant_id
        WHERE s.tenant_id = $1 AND s.slug = $2
        GROUP BY s.id`,
      [tenantId, slug],
    );
    return rows[0] ? toSource(rows[0]) : null;
  }

  async deleteSource(tenantId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.#pool.query(
      'DELETE FROM memory_sources WHERE id = $1 AND tenant_id = $2',
      [id, tenantId],
    );
    return (rowCount ?? 0) > 0;
  }

  async ingest(input: DocumentInput): Promise<IngestOutcome> {
    const body = input.body.trim();
    if (body === '') {
      throw new MemoryError(`document "${input.title}" has no text to remember`);
    }
    const checksum = createHash('sha256').update(body).digest('hex');

    // Unchanged is the common case for a re-ingest, and embedding is what
    // costs — so the check happens before anything is sent anywhere.
    const existing = await this.#existing(input, checksum);
    if (existing) {
      return { document: existing, embedded: false };
    }

    const pieces = chunk(body, this.#chunking);
    if (pieces.length === 0) {
      throw new MemoryError(`document "${input.title}" produced no chunks`);
    }
    const embedder = await this.#embedders.for(input.tenantId);
    const vectors = await embedder.embed(pieces);
    assertDimensions(embedder.model, vectors, embedder.dimensions);

    const client = await this.#pool.connect();
    try {
      await client.query('BEGIN');
      const document = await upsertDocument(client, input, checksum);
      // Replaced wholesale rather than diffed: a document's chunks are derived
      // from its body, and a body that changed makes every ordinal suspect.
      await client.query('DELETE FROM memory_chunks WHERE document_id = $1 AND tenant_id = $2', [
        document.id,
        input.tenantId,
      ]);
      for (const [ordinal, text] of pieces.entries()) {
        await client.query(
          `INSERT INTO memory_chunks (tenant_id, document_id, ordinal, text, embedding)
           VALUES ($1, $2, $3, $4, $5)`,
          [input.tenantId, document.id, ordinal, text, toVector(vectors[ordinal]!)],
        );
      }
      await client.query('COMMIT');

      return {
        document: { ...document, chunks: pieces.length },
        embedded: true,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async listDocuments(tenantId: string, sourceId: string, limit = 100): Promise<StoredDocument[]> {
    const { rows } = await this.#pool.query<DocumentRow>(
      `SELECT d.id, d.source_id, d.title, d.url, d.updated_at, count(c.id)::text AS chunks
         FROM memory_documents d
         LEFT JOIN memory_chunks c ON c.document_id = d.id AND c.tenant_id = d.tenant_id
        WHERE d.tenant_id = $1 AND d.source_id = $2
        GROUP BY d.id
        ORDER BY d.updated_at DESC
        LIMIT $3`,
      [tenantId, sourceId, limit],
    );
    return rows.map(toDocument);
  }

  async deleteDocument(tenantId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.#pool.query(
      'DELETE FROM memory_documents WHERE id = $1 AND tenant_id = $2',
      [id, tenantId],
    );
    return (rowCount ?? 0) > 0;
  }

  async search(tenantId: string, query: SearchQuery): Promise<SearchHit[]> {
    // An agent granted nothing searches nothing. Returning everything would be
    // the opposite of what an empty grant means.
    if (query.sourceIds.length === 0) {
      return [];
    }

    const embedder = await this.#embedders.for(tenantId);
    const [vector] = await embedder.embed([query.text]);
    if (!vector) {
      throw new MemoryError('the query could not be embedded');
    }

    const { rows } = await this.#pool.query<{
      document_id: string;
      slug: string;
      title: string;
      url: string | null;
      text: string;
      distance: string;
    }>(
      `SELECT c.document_id, s.slug, d.title, d.url, c.text,
              (c.embedding <=> $2::vector)::text AS distance
         FROM memory_chunks c
         JOIN memory_documents d ON d.id = c.document_id AND d.tenant_id = c.tenant_id
         JOIN memory_sources s ON s.id = d.source_id AND s.tenant_id = d.tenant_id
        WHERE c.tenant_id = $1
          AND d.source_id = ANY($3::uuid[])
          AND (c.embedding <=> $2::vector) <= $4
        ORDER BY c.embedding <=> $2::vector
        LIMIT $5`,
      [
        tenantId,
        toVector(vector),
        query.sourceIds,
        query.maxDistance ?? DEFAULT_MAX_DISTANCE,
        query.limit ?? DEFAULT_SEARCH_LIMIT,
      ],
    );

    return rows.map((row) => ({
      documentId: row.document_id,
      sourceSlug: row.slug,
      title: row.title,
      url: row.url,
      text: row.text,
      distance: Number(row.distance),
    }));
  }

  /** The stored document, when its body is byte-for-byte what we already have. */
  async #existing(input: DocumentInput, checksum: string): Promise<StoredDocument | null> {
    if (input.externalId === undefined) {
      return null;
    }
    const { rows } = await this.#pool.query<DocumentRow & { checksum: string }>(
      `SELECT d.id, d.source_id, d.title, d.url, d.updated_at, d.checksum,
              count(c.id)::text AS chunks
         FROM memory_documents d
         LEFT JOIN memory_chunks c ON c.document_id = d.id AND c.tenant_id = d.tenant_id
        WHERE d.tenant_id = $1 AND d.source_id = $2 AND d.external_id = $3
        GROUP BY d.id`,
      [input.tenantId, input.sourceId, input.externalId],
    );
    const row = rows[0];
    return row && row.checksum === checksum ? toDocument(row) : null;
  }
}

async function upsertDocument(
  client: PoolClient,
  input: DocumentInput,
  checksum: string,
): Promise<StoredDocument> {
  const { rows } = await client.query<DocumentRow>(
    `INSERT INTO memory_documents
       (tenant_id, source_id, external_id, title, body, url, checksum, metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (source_id, external_id)
     DO UPDATE SET title = excluded.title,
                   body = excluded.body,
                   url = excluded.url,
                   checksum = excluded.checksum,
                   metadata = excluded.metadata,
                   updated_at = now()
     RETURNING id, source_id, title, url, updated_at, 0::text AS chunks`,
    [
      input.tenantId,
      input.sourceId,
      input.externalId ?? null,
      input.title,
      input.body,
      input.url ?? null,
      checksum,
      JSON.stringify(input.metadata ?? {}),
    ],
  );
  return toDocument(rows[0]!);
}

function toSource(row: SourceRow): MemorySource {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    kind: row.kind,
    connectionId: row.connection_id,
    documents: Number(row.documents),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toDocument(row: DocumentRow): StoredDocument {
  return {
    id: row.id,
    sourceId: row.source_id,
    title: row.title,
    url: row.url,
    chunks: Number(row.chunks),
    updatedAt: row.updated_at,
  };
}
