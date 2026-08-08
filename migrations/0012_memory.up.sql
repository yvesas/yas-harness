-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- Supermemory: shared knowledge every granted agent can search.
--
-- Deliberately *not* the same thing as a pool. A pool is one agent's own state,
-- private by decision and shared only when its owner answers a request. This is
-- knowledge — documents somebody added, and what the connectors brought — read
-- by whichever agents were granted the source it lives in. Two different
-- questions, two different tables, two different permission models.

-- A named bucket of knowledge. An agent is granted a source, not a document.
CREATE TABLE memory_sources (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    -- Stable handle a config file can name, so a grant survives a re-created
    -- source: `config/agents/*.json` cannot reference a uuid nobody has yet.
    slug          text        NOT NULL,
    name          text        NOT NULL,
    description   text,
    -- Where its documents come from. `manual` is somebody adding them;
    -- `connection` is ingested from a connected source.
    kind          text        NOT NULL DEFAULT 'manual',
    -- The connection ingested from, when there is one. Not a foreign key on
    -- purpose: a source outlives the connection it was filled from, and losing
    -- a connection should not delete knowledge already gathered.
    connection_id uuid,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT memory_sources_slug_format CHECK (slug ~ '^[a-z][a-z0-9-]{1,63}$'),
    CONSTRAINT memory_sources_kind_check CHECK (kind IN ('manual', 'connection')),
    -- One slug per tenant: it is what a grant names.
    CONSTRAINT memory_sources_slug_unique UNIQUE (tenant_id, slug),
    -- Target for the documents composite foreign key below.
    CONSTRAINT memory_sources_id_tenant_key UNIQUE (id, tenant_id)
);

-- One document, as it was ingested. The text is kept whole alongside its
-- chunks: a chunk is what search finds, and the document is what a person
-- opens to see whether the chunk was worth trusting.
CREATE TABLE memory_documents (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid        NOT NULL,
    source_id   uuid        NOT NULL,
    -- The id this had at the source it came from, so re-ingesting updates
    -- rather than duplicating. Null for something typed in by hand.
    external_id text,
    title       text        NOT NULL,
    body        text        NOT NULL,
    url         text,
    -- Of the body. Re-ingesting an unchanged document should cost nothing, and
    -- embedding is the expensive part.
    checksum    text        NOT NULL,
    metadata    jsonb       NOT NULL DEFAULT '{}'::jsonb,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT memory_documents_source_fkey
        FOREIGN KEY (source_id, tenant_id)
        REFERENCES memory_sources (id, tenant_id) ON DELETE CASCADE,
    -- Same document from the same source is one row, however often it is seen.
    CONSTRAINT memory_documents_external_unique UNIQUE (source_id, external_id),
    CONSTRAINT memory_documents_id_tenant_key UNIQUE (id, tenant_id)
);

CREATE INDEX memory_documents_source_idx ON memory_documents (tenant_id, source_id);

-- What search actually matches. A document is too big to embed as one vector
-- and too big to hand a model whole.
CREATE TABLE memory_chunks (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid        NOT NULL,
    document_id uuid        NOT NULL,
    -- Position in the document, so neighbouring chunks can be read in order.
    ordinal     integer     NOT NULL,
    text        text        NOT NULL,
    -- 1536 dimensions: what most embedding models in reach produce, and what
    -- the harness validates against at ingest. A deployment whose model differs
    -- changes this number in its fork -- the size is part of the column type,
    -- so it cannot be configuration.
    embedding   vector(1536) NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT memory_chunks_document_fkey
        FOREIGN KEY (document_id, tenant_id)
        REFERENCES memory_documents (id, tenant_id) ON DELETE CASCADE,
    CONSTRAINT memory_chunks_ordinal_unique UNIQUE (document_id, ordinal)
);

-- Cosine distance, which is what the search uses. IVFFlat rather than HNSW:
-- it builds far faster on a small corpus, and a personal knowledge base is a
-- small corpus. A deployment that outgrows it changes the index, not the query.
CREATE INDEX memory_chunks_embedding_idx
    ON memory_chunks USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

CREATE INDEX memory_chunks_tenant_idx ON memory_chunks (tenant_id);
