-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- The connection layer's storage: a per-tenant data key (envelope
-- encryption), the connections a tenant has authorised, and their encrypted
-- credentials. Secrets live only as sealed bytes; nothing here is readable
-- without the master key the operator holds outside the database.

-- One wrapped data key per tenant. The key itself is sealed under the master
-- key (the KEK), so this column is useless on its own.
CREATE TABLE tenant_keys (
    tenant_id  uuid        PRIMARY KEY REFERENCES tenants (id) ON DELETE CASCADE,
    sealed_dek bytea       NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- The record of an authorised connection. Freely readable — it holds no secret.
CREATE TABLE connections (
    id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id     uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    -- Which connector. Not a foreign key: connectors are code that registers
    -- at runtime, not rows.
    connector_id  text        NOT NULL,
    account_label text,
    status        text        NOT NULL DEFAULT 'active',
    scopes        text[]      NOT NULL DEFAULT '{}',
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    CONSTRAINT connections_connector_id_format CHECK (connector_id ~ '^[a-z][a-z0-9_-]{1,63}$'),
    CONSTRAINT connections_status_check CHECK (status IN ('active', 'expired', 'revoked', 'error')),
    -- Target for the credentials composite foreign key below.
    CONSTRAINT connections_id_tenant_key UNIQUE (id, tenant_id)
);

CREATE INDEX connections_tenant_connector_idx ON connections (tenant_id, connector_id);

-- The sealed credential for a connection. One per connection. The bytes are
-- encrypted under the tenant's data key; the agent never reads this table.
CREATE TABLE credentials (
    connection_id uuid        PRIMARY KEY,
    tenant_id     uuid        NOT NULL,
    sealed_secret bytea       NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    updated_at    timestamptz NOT NULL DEFAULT now(),

    -- A credential can only belong to a connection of the same tenant.
    CONSTRAINT credentials_connection_fkey
        FOREIGN KEY (connection_id, tenant_id)
        REFERENCES connections (id, tenant_id)
        ON DELETE CASCADE
);

COMMENT ON TABLE credentials IS
    'Encrypted connection secrets. Sealed under the tenant data key; unreadable without the master key.';
