# `src/tenants/` — the isolation boundary

Every other table carries a `tenant_id`, and every other port takes one as its
first argument. This folder is where that id comes from.

## Boundary

- **The harness does not model who a tenant is.** A person, a company, a
  workspace, a household — that is the product's question. What the harness
  owns is that the boundary exists, has a stable id, and can be created, found
  and erased.
- **Erasure is one call.** Every user-data table cascades from `tenants`, so
  `delete` removes the conversations, pools, credentials, approvals and traces
  with it. That is the mechanism behind a deletion request — a right the harness
  has to be able to *honour*, not just describe.
- **The slug rule is checked twice, on purpose.** The store raises a typed error
  naming the rule; the table's constraint means a row written by anything else —
  a migration, a script, another service — still cannot break it.

## Why this exists at all

It was missing until F7.2b. Sessions, pools, credentials, approvals, traces and
usage all demanded a `tenantId`, and nothing could produce one: every test and
the first example wrote `INSERT INTO tenants` by hand. Building a real consumer
on the harness is what surfaced it — a product's very first action had no API.
