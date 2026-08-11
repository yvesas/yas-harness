-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- The embedding column is as wide as the model somebody chose.
--
-- Migration 0012 declared vector(1536), which is what OpenAI returns and what
-- nothing else does: Voyage, Cohere and Mistral return 1024, a local nomic 768.
-- A number written into the schema makes the schema choose the vendor, and this
-- project does not choose vendors for the people who fork it.
--
-- So the width now comes from `embedding.dimensions` in config/models.json,
-- substituted by the migration runner. A deployment that declares nothing keeps
-- 1536 and this migration changes nothing it can notice.
--
-- The chunks are DROPPED rather than converted, and that is not laziness:
-- vectors from two different models describe different spaces, so there is no
-- arithmetic that turns one into the other. Changing the model means embedding
-- the corpus again. The documents themselves are untouched -- `memory_documents`
-- keeps every body -- so re-indexing is a re-run, not a re-import.

DELETE FROM memory_chunks;

ALTER TABLE memory_chunks
    ALTER COLUMN embedding TYPE vector(${EMBEDDING_DIMENSIONS});

-- The checksums recorded what was embedded. With nothing embedded any more,
-- leaving them would make the next ingest skip the work it now has to redo.
UPDATE memory_documents SET checksum = '';
