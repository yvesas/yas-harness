-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- Rolling back has to decide what a `changes_requested` row becomes, because
-- the old CHECK has no name for it. It becomes `rejected`, with its note kept
-- in `reason`: the reviewer did decline to run the call as written, which is
-- what the old vocabulary can say truthfully. Calling it `approved` would
-- invent a permission nobody gave.

UPDATE approvals SET status = 'rejected' WHERE status = 'changes_requested';

ALTER TABLE approvals
    DROP CONSTRAINT approvals_changes_need_reason;

ALTER TABLE approvals
    DROP CONSTRAINT approvals_status_check;

ALTER TABLE approvals
    ADD CONSTRAINT approvals_status_check
        CHECK (status IN ('pending', 'approved', 'rejected'));

ALTER TABLE approvals
    DROP COLUMN risk,
    DROP COLUMN consequence,
    DROP COLUMN policy_source;
