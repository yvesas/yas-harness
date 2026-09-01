-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- Dropping the columns takes their CHECK constraints and comments with them.
--
-- What it also takes is the provenance of everything already ingested, which
-- cannot be reconstructed by re-running the up migration. That is the nature of
-- the information rather than a flaw in the rollback: nothing in a document's
-- text says who added it.

ALTER TABLE memory_documents
    DROP COLUMN provenance,
    DROP COLUMN importance;
