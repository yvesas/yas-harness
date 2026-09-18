-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- Dropping the column takes its CHECK and its comment with it.
--
-- What it also takes is the distinction itself: with the column gone, a
-- scheduled run and a person typing become the same row again, and re-running
-- the up migration cannot tell them apart — every existing session comes back
-- as `interactive`. That is the nature of the information, not a flaw in the
-- rollback. It is also the reason the column exists.

ALTER TABLE sessions
    DROP COLUMN kind;
