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

## Connections and credentials

- **The first real connector is Confluence Cloud, and it validated the
  contract.** Pages map to resources, storage-format body to content, cursor
  pagination to `nextCursor`, and Confluence's read-then-write version rule is
  hidden inside `update`. No product domain leaked in — a page is a document.
- **Confluence discovers its `cloudId` at runtime, not from the credential.**
  The refresher rewrites a plain `OAuthToken` on refresh, which would drop any
  extra field, so the site id is fetched from `accessible-resources` and cached
  per connection for the process lifetime instead of stored alongside the token.
- **OAuth is mechanics, not web endpoints.** The harness builds the
  authorization URL, exchanges the code and refreshes the token; minting
  `state`, redirecting the user and receiving the callback are the product's
  job — the same boundary as approval. See
  [ADR 0007](./adr/0007-oauth-and-transparent-refresh.md).
- **Token refresh is transparent, inside an active connection.** A stale access
  token is refreshed on next use (with a skew, to avoid racing expiry) and
  stored back; the connector and agent only ever see a working token. A
  connection becomes `expired` only when a refresh actually fails and
  re-authorisation is needed — then the next call fails fast.
- **OAuth providers are declared in `config/connectors.json`, secret from env.**
  Endpoints, client id and scopes live in the file, keyed by connector id; the
  client secret is named there by its environment variable and resolved at load
  time, so no secret is committed. A missing named secret fails at startup.
- **The manager takes a `CredentialResolver`, not the vault directly.** The
  default reads the vault as-is (right for a static API key); the OAuth resolver
  adds refresh. A non-OAuth connector's credential passes through untouched, so
  both kinds coexist without a special case in the run path.
- **Every source fits one resource-shaped contract** (list, read, search,
  create, update, delete over a `Resource`). Adding Drive, Confluence or Notion
  is registering a connector; the manager, vault and schema do not change.
  Source-specific fields live in a `metadata` bag so translation loses nothing.
  See [ADR 0006](./adr/0006-connector-contract.md).
- **Editing is first-class, not read-only-first.** create/update/delete are in
  the contract from the start; the dogfooding case and the products both need
  to write back, and retrofitting write is worse than designing for it once.
- **Capabilities are declared and gated.** A connector declares what it does;
  the registry checks every declared capability has its method, and the manager
  refuses an undeclared one. A connector may implement more than it declares (a
  full connector in read-only mode), which is allowed on purpose.
- **The connection manager is the credential seam.** It resolves the credential
  from the vault and hands it to the connector for the length of the call; the
  status and capability checks run before anything is decrypted. A connector
  receives a credential and must never log, store or return it.
- **Credentials use envelope encryption with a per-tenant data key.** A master
  key wraps each tenant's data key; the data key encrypts that tenant's
  secrets. One key compromise stays within a tenant, and rotating the master
  key re-wraps the data keys without re-encrypting a credential. See
  [ADR 0005](./adr/0005-connection-layer-and-credential-vault.md).
- **AES-256-GCM over Node's own crypto, no dependency.** Authenticated, so a
  tampered blob fails to open rather than decrypting to garbage; the surface
  used is four calls wide.
- **The connection record and its secret live in different tables.**
  `connections` holds no secret and is freely readable; `credentials` holds the
  sealed bytes. Common reads never touch anything encrypted.
- **The vault is the only code that decrypts, and only the connection layer
  calls it, at call time.** That is what "the agent never sees API keys" means
  concretely; the boundary check keeps `src/core/` from importing the vault.
- **Credential isolation is a composite foreign key.** A credential can only
  attach to a connection of the same tenant — a cross-tenant credential cannot
  be inserted, not merely should not be.
- **The vault is built only when a master key is configured.** A deployment
  that connects nothing does not need one; starting it with a missing key would
  be worse than starting without the vault.

## Approval

- **An approval pause is a return, not a block.** A gated tool makes the agent
  record pending approvals and return `awaiting_approval`; a later `resume`
  continues. No process is held open, and the pause survives a restart because
  its whole state is in the session and the approval queue. See
  [ADR 0004](./adr/0004-human-approval.md).
- **A turn with any gated call is all-or-nothing.** Nothing in the turn runs —
  not even the ungated calls beside it — until every gate is decided, so a
  half-run turn can never be observed.
- **A decision is guarded in the `WHERE` clause.** Moving an approval off
  `pending` only matches a still-pending row, so two operators deciding the
  same approval race on the database and exactly one wins.
- **A rejection reaches the model as a tool result with its reason**, not as a
  failed turn, so the model can change course rather than just stop.
- **A gated tool still fails closed when no approval queue is wired.** The
  approval store is optional; without it, a product does not run sensitive
  actions unchecked by omission.
- **"Who decided" is an opaque string.** The harness does not model operators;
  a product binds real identities to `decidedBy` itself.

## Core and storage

- **Message order is a `seq` identity column, not `created_at`.** `now()` is
  the transaction timestamp, so messages appended together share one value and
  would otherwise sort arbitrarily — a conversation could come back scrambled.
- **The agent passes a snapshot of history to the gateway, not its working
  array.** The loop keeps appending; an adapter must see the conversation as it
  was at call time.
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
