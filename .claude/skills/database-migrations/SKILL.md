---
name: database-migrations
description: Use when changing the database schema of yas-harness — adding or altering a table, column, index or constraint. Covers the migration file format, the tenant_id rule, and how to test a rollback.
---

# Changing the schema

## 1. Create the pair

Migrations live in `migrations/` as two files that share a version:

```
migrations/0002_sessions.up.sql
migrations/0002_sessions.down.sql
```

- Version is the next zero-padded number. Never renumber or edit an applied
  migration — add a new one.
- **Both files are mandatory.** The runner refuses a migration without a
  `.down.sql`; an irreversible migration is not shippable.
- Start each file with the license header (`npm run license:fix` adds it).
- The runner wraps each file in a transaction, so do not write `BEGIN`/`COMMIT`.

## 2. Obey the tenant rule

Any table holding user data carries `tenant_id`, and the isolation is enforced
by the database, not by application discipline:

```sql
CREATE TABLE sessions (
    id         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id  uuid        NOT NULL REFERENCES tenants (id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);

-- Every lookup is tenant-scoped, so every index leads with tenant_id.
CREATE INDEX sessions_tenant_created_idx ON sessions (tenant_id, created_at DESC);
```

Rules that follow from this:

- `NOT NULL REFERENCES tenants (id)` — no orphan rows, no global rows
- Composite indexes and unique constraints start with `tenant_id`
- A cross-tenant query is a bug; there is no "admin sees everything" shortcut here

## 3. Run it

```bash
docker compose up -d       # Postgres on host port 4000
npm run migrate status
npm run migrate up
```

## 4. Test the rollback — always

A migration is only done when it survives this round trip:

```bash
npm run migrate up
npm run migrate down       # rolls back the last applied migration
npm run migrate up
```

If `down` leaves anything behind (a table, a type, an extension, a column), fix
the `.down.sql` before opening the pull request. CI runs exactly this sequence.

Also add a test under `tests/integration/` when the change carries an isolation
guarantee: prove that tenant A cannot read tenant B's rows.

## 5. Before the pull request

- [ ] `.up.sql` and `.down.sql` both present, both with license headers
- [ ] `tenant_id` on every user-data table, with a foreign key
- [ ] Indexes lead with `tenant_id`
- [ ] up → down → up runs clean locally
- [ ] `npm run check` passes

## Notes

- `gen_random_uuid()` is built into Postgres 13+; no extension needed.
- `vector` (pgvector) is enabled in `0001_init`. Use it for embeddings only.
- Use `timestamptz`, never `timestamp`.
- Prefer a `CHECK` constraint over validating a format in application code.
