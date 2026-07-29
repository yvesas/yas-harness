-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- What the agent did, step by step: the input, the routing decision, each model
-- call, each tool, and how the turn ended. This is the diagnostic record;
-- model_usage is the billing one, and they are deliberately separate tables.
--
-- The difference that matters is deletion. A usage row survives a deleted
-- conversation because the money was still spent (it only nulls session_id). A
-- trace does not: it carries the user's own words, so when a conversation is
-- deleted the trace of it goes too.

CREATE TABLE traces (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    -- Null for work outside a conversation, such as a standalone routing call.
    session_id  uuid,
    -- Groups the steps of one turn. Not a foreign key: a caller may start a
    -- trace before the agent does (routing, then the turn it routed to).
    trace_id    uuid        NOT NULL,
    -- Position within the turn. created_at cannot carry it: now() is the
    -- transaction timestamp, so steps written together share one value.
    sequence    integer     NOT NULL,
    kind        text        NOT NULL,
    -- What the step was about: a module id, a tool name, a model.
    label       text,
    duration_ms integer,
    succeeded   boolean     NOT NULL,
    -- Anything else worth seeing: routing confidence and reason, a stop reason,
    -- a tool's input. Redacted before it gets here.
    detail      jsonb,
    error_message text,
    created_at  timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT traces_kind_check CHECK (
        kind IN ('input', 'route', 'model_call', 'tool_call', 'approval', 'reply')
    ),
    CONSTRAINT traces_sequence_check CHECK (sequence >= 0),
    CONSTRAINT traces_duration_check CHECK (duration_ms IS NULL OR duration_ms >= 0),
    CONSTRAINT traces_detail_is_object CHECK (detail IS NULL OR jsonb_typeof(detail) = 'object'),
    -- A step can only belong to a session of its own tenant, and goes with it.
    CONSTRAINT traces_session_fkey
        FOREIGN KEY (session_id, tenant_id)
        REFERENCES sessions (id, tenant_id)
        ON DELETE CASCADE,
    -- One step per position per turn. Makes a duplicated or overwritten
    -- sequence a write that fails rather than a trace that silently misreads.
    CONSTRAINT traces_step_unique UNIQUE (tenant_id, trace_id, sequence)
);

-- Answers "show me this turn", the query a trace exists for.
CREATE INDEX traces_trace_idx ON traces (tenant_id, trace_id, sequence);

-- Answers "what happened in this conversation", and "what happened recently".
CREATE INDEX traces_session_idx ON traces (tenant_id, session_id, created_at DESC)
    WHERE session_id IS NOT NULL;
