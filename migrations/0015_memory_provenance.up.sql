-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- Where a document came from, and how much it is worth.
--
-- Two columns that are cheap now and impossible to backfill later. A corpus
-- with content in it cannot be told, after the fact, which documents its owner
-- wrote and which arrived from a connected source — the information was never
-- recorded, and no amount of scanning the text recovers it. So they go in while
-- the tables are still empty.
--
-- `provenance` is a closed set written by the code path that ingests, never by
-- a model and never inferred from content. That is the security boundary: a
-- poisoned fact reads exactly like a true one, so the question "can this be
-- trusted" has to be answered by *who put it there*, which only the writer
-- knows. The default is the untrusting one on purpose — a raw INSERT that
-- forgets the column cannot mint owner-grade knowledge.
--
-- `importance` is the second ranking signal. Distance alone has already been
-- observed ranking correctly and *excluding* nothing: an unrelated passage came
-- back at 0.573, inside the 0.6 ceiling. A ceiling is a bad sole gate, and this
-- is what lets ranking stop depending on it.
--
-- Recency, the third signal, needs no column: `updated_at` is already here.

ALTER TABLE memory_documents
    ADD COLUMN provenance text     NOT NULL DEFAULT 'untrusted',
    ADD COLUMN importance smallint NOT NULL DEFAULT 5;

ALTER TABLE memory_documents
    ADD CONSTRAINT memory_documents_provenance_check
        CHECK (provenance IN ('owner', 'agent', 'untrusted', 'system')),
    ADD CONSTRAINT memory_documents_importance_check
        CHECK (importance BETWEEN 1 AND 10);

COMMENT ON COLUMN memory_documents.provenance IS
    'Who put this here: owner (a person), agent (the model wrote it), untrusted (came from outside), system (scaffolding). Written by the ingest path, never by a model.';
COMMENT ON COLUMN memory_documents.importance IS
    '1-10, assigned at write time. Ranking signal, not a filter.';
