-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0

ALTER TABLE model_usage
    DROP CONSTRAINT IF EXISTS model_usage_compression_tokens_check,
    DROP CONSTRAINT IF EXISTS model_usage_compression_pair_check,
    DROP COLUMN IF EXISTS compression_after_tokens,
    DROP COLUMN IF EXISTS compression_before_tokens;
