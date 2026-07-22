# Design decisions

The smaller calls that shaped the code but are too narrow for an
[ADR](./adr/). One line each, newest first, with the reason. When a choice is
load-bearing enough that a future reader would re-litigate it, it becomes an
ADR instead.

## Router and modules

- **The router validates the model's choice against the registry.** A cheap
  model occasionally names a module that does not exist; that is a routing
  failure to surface, not a module to invent. It throws rather than guessing.
- **The router is forgiving about JSON wrapping, strict about shape.** A cheap
  model often wraps its reply in prose or a code fence; the router extracts the
  first balanced `{...}` object, then validates it against a schema. Forgiving
  where the model is sloppy, strict where correctness matters.
- **A single registered module short-circuits with no model call.** A routing
  decision with one option is not a decision, and it is the common early case.
- **The router eval is a required step, not a nicety.** A cheap router is only
  worth trusting once its hit rate is measured; the `adding-a-module` skill
  makes shipping a case set part of adding a module.
- **Pools are isolated by the primary key `(tenant_id, module_id, key)`**, so
  isolation is the table's shape rather than a discipline every query must
  keep. No query can span a tenant or a module boundary.
- **The in-memory pool store's methods are `async` with no `await`.** They do
  no I/O, but being async turns a rejected key into a rejected promise — the
  same shape the Postgres adapter has, and the shape callers expect.

## Models and cost

- **Routes, tiers and prices live in `config/models.json`, not in code.** They
  are the fastest-moving facts here; a price change should be a reviewed config
  edit, not a release.
- **The `sensitive` route may not contain a cheap model, anywhere in its
  chain** — validated at load. Getting a sensitive answer wrong costs more than
  the tokens saved, and the failure would look merely like a worse answer.
- **A route naming an undefined model is rejected at load**, not when that
  fallback is finally needed during an outage.
- **The Groq adapter is written against `fetch`, not a client library.** The
  surface used is three fields wide; a dependency would buy only a version to
  keep up with.
- **Only transient failures are retried** (rate limits, timeouts, provider
  faults), with exponential backoff, then the next candidate. A rejected
  request fails the same way however often it is sent.
- **`model_usage` records one row per attempt, failures included.** A provider
  that fails half the time is a fact worth seeing, and its retries are latency
  users feel.
- **Cost is stored as `numeric`, never a float**, and computed to sub-cent
  precision — most single calls cost fractions of a cent, and rounding to cents
  would report them as zero.
- **`model_usage` keeps its billing row when a conversation is deleted**, using
  `ON DELETE SET NULL (session_id)` (PostgreSQL 15+). A plain `SET NULL` on the
  composite key would also null `tenant_id`, which is `NOT NULL`, and the
  delete would fail.
- **Extended thinking is not enabled.** It requires echoing provider-specific
  blocks back unchanged, which the gateway port cannot express yet; the adapter
  drops those blocks rather than half-supporting the feature.

## Core and storage

- **Message order is a `seq` identity column, not `created_at`.** `now()` is
  the transaction timestamp, so messages appended together share one value and
  would otherwise sort arbitrarily — a conversation could come back scrambled.
- **The agent passes a snapshot of history to the gateway, not its working
  array.** The loop keeps appending; an adapter must see the conversation as it
  was at call time.
- **Approval-gated tools fail closed.** `requiresApproval` exists in the tool
  contract now; until the approval queue lands (phase 4), the agent refuses
  those tools rather than running them unchecked.
- **A tool declares its input with a Zod schema, and the registry derives the
  JSON Schema the model sees.** One definition, so what is advertised cannot
  drift from what is validated.
- **Invalid input, unknown tools and thrown tools become error results, not
  exceptions.** The model gets to see what went wrong and correct itself, which
  is the point of feeding the result back.
- **Personas are declarative configuration in `config/personas/`**, validated
  with Zod and versioned in Git — so instructions change without touching the
  loop.

## Toolchain and project

- **Native ESM with relative `.js` imports; no path aliases.** Aliases would
  need a bundler or a runtime resolution hack; `tsc` plus Node ESM resolves
  without an extra dependency.
- **Two `tsconfig` files.** The root type-checks `src` and `tests` without
  emitting; `tsconfig.build.json` compiles `src` only.
- **The migration runner is plain ESM (`scripts/migrate.mjs`), not
  TypeScript.** It runs identically from source and from the Docker image, with
  no build step and no dev dependency in production.
- **Every migration must have a reversible `.down.sql`.** The runner refuses a
  migration without one; CI proves the round trip up → down → up.
- **Git hooks run via `core.hooksPath`, not husky** — the same guarantee with
  no dependency, enabled by `npm run prepare`.
- **The local Postgres host port is in the 4000 block, not 5432.** The default
  ports collide with other projects run alongside this one; the container's
  internal port is unchanged.
- **TypeScript is held below 7 in Dependabot.** `typescript-eslint` 8.x caps at
  `typescript <6.1.0`, so a bump to 7 fails `npm ci` on the peer conflict and
  takes the grouped update down with it. Revisit when typescript-eslint
  supports TypeScript 7.
- **The commit-message check skips bot commits.** They are generated, not
  authored; what lands on `main` is the squash title a maintainer writes. Every
  rule still applies in full to every human commit.
