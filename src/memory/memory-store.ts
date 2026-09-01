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

/**
 * Who put a document in the corpus.
 *
 * A closed set, written by the ingest path and never by a model. It is not a
 * description of the content — it is a statement about the writer, which is the
 * only thing that survives an adversary: a poisoned fact reads exactly like a
 * true one, so scanning text cannot answer "can this be trusted" and the
 * question has to be settled where the content entered.
 *
 * - `owner` — a person put it there deliberately
 * - `agent` — the model wrote it, from its own work
 * - `untrusted` — it came from outside: a connected source, a fetched page
 * - `system` — scaffolding the harness itself added
 */
export type Provenance = 'owner' | 'agent' | 'untrusted' | 'system';

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
  /**
   * Who is putting it there. **Required, and deliberately not defaulted**: the
   * caller is the only one who knows, and a default would be a guess recorded
   * as a fact. The compiler asking is the whole mechanism — there is nothing
   * downstream that can work this out later.
   */
  readonly provenance: Provenance;
  /**
   * 1–10, how much this is worth remembering. A ranking signal, never a
   * filter. Assigned here because this is where somebody — a person, or a
   * model already in the loop — knows; search has no way to judge it.
   */
  readonly importance?: number;
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
  /** Who put the document here. Returned so a caller can weigh it. */
  readonly provenance: Provenance;
  readonly importance: number;
  /**
   * What the hit was ordered by: relevance × recency × importance, in (0, 1].
   *
   * Returned beside `distance` rather than instead of it, because they answer
   * different questions — distance is how close the text is, score is how much
   * this passage is worth showing a model. A caller that only wants nearest
   * still has the number it had before.
   */
  readonly score: number;
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
 *
 * It is a **filter**, and on its own it is a bad gate: an unrelated passage has
 * been measured at 0.573, comfortably inside it. That is why ranking below does
 * not depend on it.
 */
export const DEFAULT_MAX_DISTANCE = 0.6;

/** How much a document is worth when nobody said. Neutral, not high. */
export const DEFAULT_IMPORTANCE = 5;

/**
 * How long until recency has halved a document's weight.
 *
 * Ninety days is long on purpose. A knowledge base is mostly reference — a
 * design note from last quarter is as true as it was — so recency is here to
 * break ties between comparable passages, not to bury the corpus.
 */
export const RECENCY_HALF_LIFE_DAYS = 90;

/**
 * The share of its weight an old document keeps, however old.
 *
 * Without a floor, multiplying by an exponential decay *erases* rather than
 * ranks: at a 90-day half-life a two-year-old document scores near zero and can
 * never be returned, no matter how exactly it answers the question. That is the
 * ceiling's failure mode again, wearing a different hat. With the floor, age
 * can cost a passage at most half its score.
 */
export const RECENCY_FLOOR = 0.5;

/**
 * How many nearest neighbours are re-ranked to produce one page of results.
 *
 * Ranking cannot be pushed into the vector index — the index knows distance and
 * nothing about recency or importance — so the query takes a pool of the
 * nearest by distance, which *is* indexed, and reorders that. Too small a pool
 * and re-ranking has nothing to reorder; too large and it sorts the corpus.
 */
export const CANDIDATE_MULTIPLIER = 5;
