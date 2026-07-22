-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- The human-approval queue. One row per gated tool call. The row is the whole
-- state of a paused turn, so a pause survives a restart and costs nothing
-- while it waits — no process blocks on it. It is also the audit trail: what
-- was asked, what was decided, and by whom.

CREATE TABLE approvals (
    id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id    uuid        NOT NULL,
    session_id   uuid        NOT NULL,
    -- The tool call this decision gates, from the assistant turn in messages.
    tool_call_id text        NOT NULL,
    tool_name    text        NOT NULL,
    input        jsonb       NOT NULL,
    status       text        NOT NULL DEFAULT 'pending',
    requested_at timestamptz NOT NULL DEFAULT now(),
    -- Opaque operator identifier; the harness does not model who that is.
    decided_by   text,
    decided_at   timestamptz,
    reason       text,

    CONSTRAINT approvals_status_check CHECK (status IN ('pending', 'approved', 'rejected')),
    -- A decision has a decider and a time; a pending row has neither. This
    -- keeps the audit trail honest: no silent approval, no decision by nobody.
    CONSTRAINT approvals_decision_consistency CHECK (
        (status = 'pending'  AND decided_by IS NULL AND decided_at IS NULL)
     OR (status <> 'pending' AND decided_by IS NOT NULL AND decided_at IS NOT NULL)
    ),
    -- A tenant can only gate a tool call in a session it owns.
    CONSTRAINT approvals_session_fkey
        FOREIGN KEY (session_id, tenant_id)
        REFERENCES sessions (id, tenant_id)
        ON DELETE CASCADE,
    -- One decision per tool call: a gated call cannot be queued twice.
    CONSTRAINT approvals_tool_call_unique UNIQUE (session_id, tool_call_id)
);

-- Answers "what is waiting on this operator" and "this conversation's trail".
CREATE INDEX approvals_pending_idx ON approvals (tenant_id, status)
    WHERE status = 'pending';
CREATE INDEX approvals_session_idx ON approvals (tenant_id, session_id, requested_at);
