-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0

ALTER TABLE model_usage DROP CONSTRAINT IF EXISTS model_usage_billed_to_check;
ALTER TABLE model_usage DROP COLUMN IF EXISTS billed_to;
DROP TABLE IF EXISTS tenant_model_keys;
