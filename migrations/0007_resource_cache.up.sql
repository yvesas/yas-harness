-- Copyright 2026 YAS Softwares LTDA
-- SPDX-License-Identifier: Apache-2.0
--
-- A cache of connected data: snapshots of the resources a connection has
-- fetched, so the agent can browse and read them without hitting the external
-- source every time (and can still see them when the source is down). This is
-- infrastructure, not product domain: a snapshot is a Resource, the same in a
-- language tutor and a CRM.

CREATE TABLE resource_cache (
    tenant_id     uuid        NOT NULL,
    connection_id uuid        NOT NULL,
    -- The connector's own id for the resource (e.g. "acme/widgets#7").
    resource_id   text        NOT NULL,
    -- The resource's container, copied out for browsing; null at the top level.
    parent_id     text,
    -- The Resource snapshot, exactly as the connector returned it.
    resource      jsonb       NOT NULL,
    fetched_at    timestamptz NOT NULL DEFAULT now(),

    -- One snapshot per resource per connection. Isolation is structural: a
    -- query for one connection's cache cannot return another's, nor cross a
    -- tenant, because both are in the key.
    PRIMARY KEY (tenant_id, connection_id, resource_id),

    -- A snapshot can only belong to a connection of the same tenant, and it is
    -- removed when the connection is. This is the same composite foreign key
    -- the credentials table uses.
    CONSTRAINT resource_cache_connection_fkey
        FOREIGN KEY (connection_id, tenant_id)
        REFERENCES connections (id, tenant_id)
        ON DELETE CASCADE
);

-- Browsing a folder's cached children, and pruning within a parent.
CREATE INDEX resource_cache_parent_idx
    ON resource_cache (tenant_id, connection_id, parent_id);

COMMENT ON TABLE resource_cache IS
    'Snapshots of connected resources, refreshed by polling or webhook. Holds no secret; the credential lives in the credentials table.';
