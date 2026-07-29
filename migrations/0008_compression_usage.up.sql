-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- What context compression saved on each call, recorded next to what the call
-- cost. Without this the saving is a number in a log; here it can be joined to
-- the bill it was supposed to move.
--
-- Both columns are nullable because compression is off by default: a null pair
-- means "no compressor was wired", which is different from "compression ran and
-- saved nothing" (equal values).

ALTER TABLE model_usage
    -- Measured by the harness's own TokenCounter over the request's rendered
    -- text, so it is an approximation for any provider whose tokenizer differs
    -- and does not include the provider's own framing. Deliberately not mixed
    -- with input_tokens, which is the provider's exact count.
    ADD COLUMN compression_before_tokens integer,
    ADD COLUMN compression_after_tokens  integer;

ALTER TABLE model_usage
    ADD CONSTRAINT model_usage_compression_pair_check CHECK (
        (compression_before_tokens IS NULL) = (compression_after_tokens IS NULL)
    ),
    ADD CONSTRAINT model_usage_compression_tokens_check CHECK (
        compression_before_tokens >= 0 AND compression_after_tokens >= 0
    );

-- No "after <= before" constraint on purpose. An engine is applied only when it
-- shrinks the request in *characters*, and a tokenizer can very occasionally
-- turn fewer characters into more tokens. That is a fact worth being able to
-- see in the data, not a write that should fail at 3am.
