-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- What every model call cost. Failed attempts are recorded too: a provider
-- that fails half the time is a fact worth seeing, and its retries are part
-- of the latency the user feels.

CREATE TABLE model_usage (
    id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id       uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    -- Null for calls made outside a conversation, such as routing decisions.
    session_id      uuid,
    task            text        NOT NULL,
    -- Configuration key from config/models.json, e.g. "anthropic/opus".
    model_reference text        NOT NULL,
    provider        text        NOT NULL,
    model           text        NOT NULL,
    tier            text        NOT NULL,

    input_tokens        integer NOT NULL,
    output_tokens       integer NOT NULL,
    cached_input_tokens integer NOT NULL,
    -- USD. numeric, not float: money must not accumulate rounding error.
    cost_usd        numeric(14, 8) NOT NULL,

    latency_ms      integer     NOT NULL,
    -- Which attempt in the fallback chain this record belongs to.
    attempts        integer     NOT NULL,
    succeeded       boolean     NOT NULL,
    error_message   text,
    created_at      timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT model_usage_task_check CHECK (task IN ('routing', 'simple', 'reasoning', 'sensitive')),
    CONSTRAINT model_usage_tier_check CHECK (tier IN ('cheap', 'premium')),
    CONSTRAINT model_usage_tokens_check CHECK (
        input_tokens >= 0 AND output_tokens >= 0 AND cached_input_tokens >= 0
    ),
    CONSTRAINT model_usage_cost_check CHECK (cost_usd >= 0),
    -- An error message only makes sense on a failure, and a failure without
    -- one is a record nobody can act on.
    CONSTRAINT model_usage_error_matches_outcome CHECK (succeeded = (error_message IS NULL)),
    -- Keeps the billing record when a conversation is deleted, but only
    -- nulls session_id: a bare SET NULL would also null tenant_id, which is
    -- NOT NULL, and the delete would fail. Needs PostgreSQL 15+.
    CONSTRAINT model_usage_session_fkey
        FOREIGN KEY (session_id, tenant_id)
        REFERENCES sessions (id, tenant_id)
        ON DELETE SET NULL (session_id)
);

-- Answers "what did this tenant spend, and when".
CREATE INDEX model_usage_tenant_created_idx ON model_usage (tenant_id, created_at DESC);

-- Answers "what did this conversation cost".
CREATE INDEX model_usage_session_idx ON model_usage (tenant_id, session_id)
    WHERE session_id IS NOT NULL;
