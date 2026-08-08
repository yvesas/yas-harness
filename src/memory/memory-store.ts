// Copyright 2026 YAS Softwares LTDA
// SPDX-License-Identifier: Apache-2.0

/**
 * Port: shared knowledge, and searching it.
 *
 * The layer that is **not** a pool. A pool is one agent's own state, private by
 * decision and shared only when its owner answers a request (ADR 0001, doc 13
 * decision 2). This is knowledge — documents somebody added, and what the
 * connectors brought — read by whichever agents were granted the source it
 * lives in. Two questions, two permission models, and keeping them apart is
 * what stops "everybody sees everything" arriving by the back door.
 *
 * A **source** is the unit of permission. An agent is granted a source, never a
 * document: a grant that had to enumerate documents would be out of date the
 * moment anything was ingested.
 */

export interface MemorySource {
  readonly id: string;
  readonly tenantId: string;
  /** What a grant names. Stable across a source being emptied and refilled. */
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly kind: 'manual' | 'connection';
  /** The connection it was ingested from, when it was. */
  readonly connectionId: string | null;
  readonly documents: number;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface CreateSourceInput {
  readonly tenantId: string;
  readonly slug: string;
  readonly name: string;
  readonly description?: string;
  readonly kind?: 'manual' | 'connection';
  readonly connectionId?: string;
}

/** One thing to remember, before it is chunked or embedded. */
export interface DocumentInput {
  readonly tenantId: string;
  readonly sourceId: string;
  /** Its id at the source it came from, so re-ingesting updates in place. */
  readonly externalId?: string;
  readonly title: string;
  readonly body: string;
  readonly url?: string;
  readonly metadata?: Record<string, unknown>;
}

export interface StoredDocument {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly url: string | null;
  readonly chunks: number;
  readonly updatedAt: Date;
}

/** What ingestion did, which is worth knowing because embedding costs money. */
export interface IngestOutcome {
  readonly document: StoredDocument;
  /** False when the body was unchanged and nothing had to be re-embedded. */
  readonly embedded: boolean;
}

export interface SearchQuery {
  /** Restricted to these sources. Empty means the agent may search nothing. */
  readonly sourceIds: readonly string[];
  readonly text: string;
  readonly limit?: number;
  /**
   * Cosine distance above which a match is not worth returning.
   *
   * A vector search always returns its nearest neighbours, however far away —
   * so without a ceiling, a question about nothing in the corpus comes back
   * with the least irrelevant passage and a model treats it as an answer.
   */
  readonly maxDistance?: number;
}

export interface SearchHit {
  readonly documentId: string;
  readonly sourceSlug: string;
  readonly title: string;
  readonly url: string | null;
  readonly text: string;
  /** 0 is identical. Returned so a caller can judge, not just rank. */
  readonly distance: number;
}

export interface MemoryStore {
  createSource(input: CreateSourceInput): Promise<MemorySource>;
  listSources(tenantId: string): Promise<MemorySource[]>;
  findSourceBySlug(tenantId: string, slug: string): Promise<MemorySource | null>;
  deleteSource(tenantId: string, id: string): Promise<boolean>;

  /** Add or update one document, chunking and embedding as needed. */
  ingest(input: DocumentInput): Promise<IngestOutcome>;
  listDocuments(tenantId: string, sourceId: string, limit?: number): Promise<StoredDocument[]>;
  deleteDocument(tenantId: string, id: string): Promise<boolean>;

  search(tenantId: string, query: SearchQuery): Promise<SearchHit[]>;
}

export class MemoryError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'MemoryError';
  }
}

/** How many passages a search returns unless told otherwise. */
export const DEFAULT_SEARCH_LIMIT = 6;

/**
 * The default ceiling on cosine distance.
 *
 * Cosine distance runs 0 (identical) to 2 (opposite); embeddings of ordinary
 * prose cluster well below 1, so 0.6 keeps what is plausibly on topic and drops
 * what is merely nearest. Generous rather than strict: a missing passage is a
 * worse failure here than a weak one, because a model can ignore a weak match
 * and cannot ignore something it never saw.
 */
export const DEFAULT_MAX_DISTANCE = 0.6;
