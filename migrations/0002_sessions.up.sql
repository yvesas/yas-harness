-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- Conversation state: a session and its messages. Both carry tenant_id, and
-- the composite foreign key makes a cross-tenant message impossible to insert
-- rather than merely discouraged.

CREATE TABLE sessions (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    persona_id text        NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT sessions_persona_id_format CHECK (persona_id ~ '^[a-z][a-z0-9-]{1,63}$'),
    -- Target for the composite foreign key below.
    CONSTRAINT sessions_id_tenant_key UNIQUE (id, tenant_id)
);

CREATE INDEX sessions_tenant_created_idx ON sessions (tenant_id, created_at DESC);

CREATE TABLE messages (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Conversation order. created_at cannot carry it: now() is the
    -- transaction timestamp, so messages appended together share one value
    -- and would sort arbitrarily.
    seq        bigint      GENERATED ALWAYS AS IDENTITY,
    session_id uuid        NOT NULL,
    tenant_id  uuid        NOT NULL,
    role       text        NOT NULL,
    -- Provider-neutral content parts, as defined by the model gateway port.
    content    jsonb       NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT messages_role_check CHECK (role IN ('user', 'assistant')),
    CONSTRAINT messages_content_is_array CHECK (jsonb_typeof(content) = 'array'),
    -- A message can only belong to a session of its own tenant.
    CONSTRAINT messages_session_fkey
        FOREIGN KEY (session_id, tenant_id)
        REFERENCES sessions (id, tenant_id)
        ON DELETE CASCADE
);

CREATE INDEX messages_session_seq_idx ON messages (tenant_id, session_id, seq);

COMMENT ON CONSTRAINT messages_session_fkey ON messages IS
    'Tenant isolation: a message cannot reference a session owned by another tenant.';
