# ADR 0008 — A read-through cache of connected resources

- **Status:** accepted
- **Date:** 2026-07-26

## Context

Every read against a connection is a round trip to an external source — a
Google Drive file, a Confluence page, a GitHub issue. That is slow, it burns
rate limit, and it makes the agent useless the moment the source is down or the
network blinks. The connectors are already resource-shaped (ADR 0006): they
return `Resource`s, which are plain data. So the connected data can be kept
locally — a snapshot cache — and served without a round trip, "taking the
knowledge off the island."

Two things had to be settled: what the cache stores and who keeps it warm.

## Decision

**The cache stores `Resource` snapshots, per connection, isolated like every
other tenant-scoped table.** The key is `(tenant_id, connection_id,
resource_id)`, so isolation is structural — a query for one connection's cache
cannot return another's, nor cross a tenant. A composite foreign key ties a
snapshot to a connection of the same tenant and cascades on delete, so a cache
cannot outlive its connection or drift to another tenant. The row copies out
`parent_id` so a folder's cached children can be browsed without unpacking JSON.
Nothing product-domain lives here: a snapshot is a `Resource`, the same in a
language tutor and a CRM.

**The store is a port with two adapters, like the others.**
`ResourceCacheStore` (get/put/putMany/delete/list/prune) has a Postgres adapter
and an in-memory one that isolates identically, so the policy above it is
testable without a database.

**The policy is read-through, and it degrades to stale on failure.**
`CachedConnections` wraps the connection operations. A `read` serves a snapshot
while it is fresh (within a TTL); otherwise it asks the source and caches the
result. If the source fails and any snapshot exists, the stale snapshot is
served rather than the error — surviving an outage is the whole point. Writes
are write-through: a create or update caches the returned resource, a delete
drops it, so the cache never lags an edit the agent just made. A live `list`
warms the cache with the page it returns.

**Keeping the cache warm is a mechanic, not a background job.** The harness is a
library, so — exactly as OAuth refresh is offered as mechanics, not endpoints
(ADR 0007) — it exposes two methods and runs no scheduler of its own:

- `refresh` is the polling mechanic. It pages through a listing (to a cap),
  upserts every resource, and prunes the ones that vanished upstream. The
  product calls it on whatever schedule it runs. If the page cap is hit the view
  is incomplete, so it prunes nothing — pruning against a partial listing would
  delete resources that still exist.
- `invalidate` is the webhook mechanic. The product's own webhook endpoint
  receives "resource X changed" and calls it; the snapshot is dropped and the
  next read re-fetches. The harness owns no HTTP surface.

For offline browsing there are `getCached` and `listCached`, which read only the
store and never touch the source.

## Consequences

**What this buys.** Reads are cheap and mostly local; the agent keeps working
through a source outage; edits are reflected immediately; and a product can keep
the cache current by polling, by webhook, or both, without the harness running
anything in the background. The cache layer is optional and additive — a product
that wants only live calls keeps using the manager directly.

**What it costs.** A read can return data up to one TTL stale (and, on a source
outage, older). `refresh` prunes on the assumption that a full, untruncated
listing is the source of truth for its scope — right for a flat listing (Drive)
or a per-folder refresh, but a whole-connection refresh on a hierarchical source
whose top-level list does not enumerate descendants would not prune deep
resources; refreshing per parent is the precise tool. Snapshots duplicate source
data at rest (no secret — those stay in the credential vault).

**What is not solved here.** No background scheduler, and no webhook endpoint —
both are the product's, by the same boundary as OAuth. There is no partial-field
update from a webhook payload (it invalidates, it does not patch), and no
eviction/size cap beyond `prune` and the connection cascade. Search results warm
the cache but are not treated as an authoritative listing for pruning.

## Alternatives considered

**Cache raw API responses instead of `Resource`s.** Fewer assumptions about
shape. Rejected: the connectors already normalise to `Resource`, so caching that
keeps the cache connector-agnostic and directly servable; caching raw payloads
would re-do translation on every read and leak each source's shape into the
store.

**A background refresh scheduler in the harness.** Keep every cache warm
automatically. Rejected as premature and out of character: it needs a scheduler
and a way to enumerate connections, and the harness is a library, not a service.
`refresh` as a mechanic lets the product schedule it where it already runs
workers — the same call CI or a cron can make.

**Fail the read when the source is down (no stale serving).** Simpler
semantics. Rejected: it throws away the cache's main benefit. Serving a labelled
stale snapshot (the caller has `fetchedAt`) is more useful than an error for the
read paths the agent depends on.
