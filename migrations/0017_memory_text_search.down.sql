-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- Dropping the column takes its index with it. Nothing is lost that cannot be
-- rebuilt: the column is generated from `text`, which stays, so re-running the
-- up migration reconstructs it exactly.

DROP INDEX IF EXISTS memory_chunks_text_search_idx;

ALTER TABLE memory_chunks
    DROP COLUMN text_search;
