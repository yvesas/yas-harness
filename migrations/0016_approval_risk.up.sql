-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- What a reviewer needs to decide, and the answer they could not give.
--
-- The queue held the tool name and its arguments. That is enough to know *what*
-- was called and nothing about what it would do: a reviewer approving on the
-- name alone is rubber-stamping, and a queue that shows only the name has asked
-- them to. So a gated call now carries the sentence a person acts on -- "sends
-- a real email to 214 recipients" -- the risk that orders the inbox, and which
-- rule held it, so a surprising gate can be traced to its cause rather than
-- guessed at.
--
-- `changes_requested` is the third decision, and it is not a softer rejection.
-- A rejection ends the attempt. This one says *do it differently* and carries
-- the correction back into the turn -- which is the answer a reviewer usually
-- has, because most of the time the action was right and the arguments were
-- not. Without it the only way to ask for a smaller blast radius was to reject
-- and hope the model guessed what to change.
--
-- The decision-consistency constraint is rebuilt rather than extended: it names
-- 'pending' as the one status without a decider, so a new deciding status is
-- covered by the `<> 'pending'` half already. Only the status CHECK has to
-- learn the new value.

ALTER TABLE approvals
    ADD COLUMN risk          text NOT NULL DEFAULT 'medium',
    ADD COLUMN consequence   text,
    ADD COLUMN policy_source text;

ALTER TABLE approvals
    ADD CONSTRAINT approvals_risk_check
        CHECK (risk IN ('none', 'low', 'medium', 'high'));

ALTER TABLE approvals
    DROP CONSTRAINT approvals_status_check;

ALTER TABLE approvals
    ADD CONSTRAINT approvals_status_check
        CHECK (status IN ('pending', 'approved', 'rejected', 'changes_requested'));

-- A correction with nothing to correct is a dead end for the model: it learns
-- its arguments were wrong and not which one. The database refuses it.
--
-- `IS NOT NULL` alone would not: an empty string is not null, and a form that
-- posts a blank textarea sends exactly that. The blank is the likely mistake,
-- not the null, so the constraint has to name it.
ALTER TABLE approvals
    ADD CONSTRAINT approvals_changes_need_reason
        CHECK (status <> 'changes_requested' OR btrim(coalesce(reason, '')) <> '');

COMMENT ON COLUMN approvals.risk IS
    'none/low/medium/high, declared by whoever gated the call. Orders the inbox; never decides.';
COMMENT ON COLUMN approvals.consequence IS
    'What running this would do, in a sentence a person can act on. Not the tool name.';
COMMENT ON COLUMN approvals.policy_source IS
    'Which rule held this call, so a surprising gate can be traced to its cause.';
