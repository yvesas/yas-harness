-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- Back to the width 0012 declared. The chunks go again for the same reason
-- they went on the way up: a vector cannot be resized into a different space.

DELETE FROM memory_chunks;

ALTER TABLE memory_chunks
    ALTER COLUMN embedding TYPE vector(1536);

UPDATE memory_documents SET checksum = '';
