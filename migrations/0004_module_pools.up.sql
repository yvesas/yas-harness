-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- Per-module data pools. The primary key is (tenant_id, module_id, key), so
-- isolation is the table's shape rather than a discipline the queries have to
-- keep: a module's data is unreachable from another module or another tenant.

CREATE TABLE module_pools (
    tenant_id  uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    -- The module that owns this data. Not a foreign key: modules live in the
    -- products, not in a harness table, and register at runtime.
    module_id  text        NOT NULL,
    key        text        NOT NULL,
    value      jsonb       NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),

    PRIMARY KEY (tenant_id, module_id, key),

    CONSTRAINT module_pools_module_id_format CHECK (module_id ~ '^[a-z][a-z0-9_-]{1,63}$'),
    CONSTRAINT module_pools_key_not_blank CHECK (length(btrim(key)) > 0)
);

-- Answers "list this module's entries", the list() query, with the primary
-- key already covering point lookups.
CREATE INDEX module_pools_scope_idx ON module_pools (tenant_id, module_id, key);

COMMENT ON TABLE module_pools IS
    'Per-module key-value data. Isolation by (tenant_id, module_id) is enforced by the primary key.';
