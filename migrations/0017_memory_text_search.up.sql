-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- Words, alongside meaning.
--
-- A vector search finds passages that mean the same thing and is blind to the
-- ones that say the same word: an error code, a surname, a flag, a version
-- number. Those are exactly the queries where a person knows the term and is
-- looking for the place it appears, and an embedding maps them to whatever
-- prose surrounds them. So the same chunk is indexed twice — once for meaning,
-- once for words — and the two rankings are fused rather than chosen between.
--
-- `simple` rather than `english`. The English configuration stems and drops
-- English stopwords, which is an improvement for English and damage for
-- everything else: it would make the harness's search quality depend on the
-- language its corpus happens to be in, and the golden rule says this has to
-- work the same in a language tutor and a CRM. `simple` folds case and splits
-- on punctuation, which is language-neutral and is most of the value for the
-- term-lookup case this exists to serve. A deployment that knows its corpus is
-- English changes one word in its fork.
--
-- Generated rather than maintained by the application: the column cannot drift
-- from the text it describes, and no ingest path can forget to update it.
-- `to_tsvector` with an explicit configuration is immutable, which is what
-- makes it legal in a generated column at all.

ALTER TABLE memory_chunks
    ADD COLUMN text_search tsvector
        GENERATED ALWAYS AS (to_tsvector('simple', text)) STORED;

CREATE INDEX memory_chunks_text_search_idx
    ON memory_chunks USING gin (text_search);

COMMENT ON COLUMN memory_chunks.text_search IS
    'Lexical index of `text`, fused with the vector ranking by RRF at search time.';
