-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- Bring your own model: a tenant's own provider keys, sealed under the same
-- envelope as every other secret, plus who paid for a call.
--
-- These are deliberately *not* rows in `credentials`: that table hangs off a
-- connection, and a model key is not a connection to a source — nothing lists
-- or reads it, the connector registry knows nothing about it, and giving it a
-- fake connection to belong to would put a lie in the table that owns the
-- meaning of "connection".

-- One key per provider per tenant. The bytes are encrypted under the tenant's
-- data key from `tenant_keys`, so this column is useless without the master key
-- the operator holds outside the database.
CREATE TABLE tenant_model_keys (
    tenant_id     uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    -- Matches the `provider` of a model entry in config/models.json.
    provider      text        NOT NULL,
    sealed_secret bytea       NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    -- The natural key is the whole key: one tenant, one provider, one secret.
    -- A surrogate id would only invite a second row for the same pair.
    PRIMARY KEY (tenant_id, provider),
    CONSTRAINT tenant_model_keys_provider_format
        CHECK (provider ~ '^[a-z][a-z0-9_-]{1,63}$')
);

-- Whose money paid for a call.
--
-- Without it, a tenant on their own key is indistinguishable in `model_usage`
-- from one on ours, and the cost column would be billed to them twice — once by
-- their provider and once by us. `platform` is the default because that is what
-- every existing row was.
ALTER TABLE model_usage
    ADD COLUMN billed_to text NOT NULL DEFAULT 'platform';

ALTER TABLE model_usage
    ADD CONSTRAINT model_usage_billed_to_check CHECK (billed_to IN ('platform', 'tenant'));
