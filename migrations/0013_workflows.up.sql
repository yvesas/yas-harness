-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- Workflow runs: several agents in order, with places for a person to stand.
--
-- A run stops to wait for somebody and must cost nothing while it waits, so its
-- whole state is here rather than in a process. Resuming reads these rows; a
-- deploy in the middle of a run loses nothing but the step in flight.
--
-- It is also the audit trail for anything a workflow did to the outside world.
-- That is why a step keeps the prompt it actually ran with: the workflow file
-- is versioned in Git and will be edited, and "what was this agent asked" must
-- still be answerable about a run from three months ago.

CREATE TABLE workflow_runs (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    -- Not a foreign key: workflows live in Git, not in this database. A run
    -- outliving the workflow that produced it is normal and worth keeping.
    workflow_id text        NOT NULL,
    input       text        NOT NULL,
    status      text        NOT NULL DEFAULT 'running',
    error       text,
    -- Opaque operator identifier; the harness does not model who that is.
    started_by  text,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,

    CONSTRAINT workflow_runs_workflow_id_format CHECK (workflow_id ~ '^[a-z][a-z0-9-]{1,63}$'),
    CONSTRAINT workflow_runs_status_check
        CHECK (status IN ('running', 'awaiting_approval', 'completed', 'failed')),
    -- Target for the steps composite foreign key below.
    CONSTRAINT workflow_runs_id_tenant_key UNIQUE (id, tenant_id)
);

CREATE INDEX workflow_runs_tenant_started_idx ON workflow_runs (tenant_id, started_at DESC);

-- One row per step per run, rewritten as the step progresses. A step that
-- paused and resumed is one step that took a while, not three rows a reader
-- has to reconcile.
CREATE TABLE workflow_run_steps (
    id          uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id   uuid        NOT NULL,
    run_id      uuid        NOT NULL,
    step_id     text        NOT NULL,
    agent_id    text        NOT NULL,
    -- Its own conversation: one agent's tool results must not land in another
    -- agent's context. What crosses between steps is only what a prompt quotes.
    session_id  uuid,
    prompt      text        NOT NULL,
    output      text,
    trace_id    uuid,
    status      text        NOT NULL DEFAULT 'running',
    -- 'step' is the workflow's own gate, nothing has run yet; 'tool' is the
    -- agent's write gate firing mid-turn. Different resumes, so the row says.
    awaiting    text,
    approval_id uuid,
    error       text,
    started_at  timestamptz NOT NULL DEFAULT now(),
    finished_at timestamptz,

    CONSTRAINT workflow_run_steps_status_check
        CHECK (status IN ('running', 'awaiting_approval', 'completed', 'failed', 'skipped')),
    CONSTRAINT workflow_run_steps_awaiting_check CHECK (awaiting IS NULL OR awaiting IN ('step', 'tool')),
    CONSTRAINT workflow_run_steps_run_fkey
        FOREIGN KEY (run_id, tenant_id)
        REFERENCES workflow_runs (id, tenant_id) ON DELETE CASCADE,
    -- The session belongs to the same tenant as the step, enforced rather than
    -- assumed. Nulled rather than cascaded away: a step keeps its output and
    -- its prompt even if the conversation behind it is deleted.
    --
    -- The column is named on purpose. A bare SET NULL on a composite key nulls
    -- *every* column in it, tenant_id included -- which this table declares NOT
    -- NULL, so deleting a tenant would fail rather than cascade. Naming the
    -- column needs PostgreSQL 15; this repository runs 17.
    CONSTRAINT workflow_run_steps_session_fkey
        FOREIGN KEY (session_id, tenant_id)
        REFERENCES sessions (id, tenant_id) ON DELETE SET NULL (session_id),
    -- One row per step of a run; `recordStep` upserts on it.
    CONSTRAINT workflow_run_steps_step_unique UNIQUE (run_id, step_id)
);

CREATE INDEX workflow_run_steps_run_idx ON workflow_run_steps (tenant_id, run_id, started_at);
