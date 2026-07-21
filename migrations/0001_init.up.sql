-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- Baseline schema: the vector extension used for RAG, and the tenant table
-- every other user-data table will reference. Multi-tenancy starts here so it
-- is never a retrofit.

CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE tenants (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    slug       text        NOT NULL UNIQUE,
    name       text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT tenants_slug_format CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    CONSTRAINT tenants_name_not_blank CHECK (length(btrim(name)) > 0)
);

COMMENT ON TABLE tenants IS
    'Isolation boundary. Every table holding user data references this table.';
