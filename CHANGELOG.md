# Changelog

Notable changes to `yas-harness`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are **curated at release time** from the Conventional Commits on `main`
— see `.claude/skills/release-process/`. They are not a dump of the commit log:
a changelog is read by someone deciding whether to upgrade, so it records what
changed for *them*, not every commit that got there.

## [Unreleased]

Nothing yet.

## [1.0.0] - 2026-08-04

The first tagged release. Everything below arrived before it, so this is what
the harness *is* rather than what changed — read it as the feature list.

**From here the ports are the contract.** Until now they were explicitly
unstable; after this tag, removing a method, adding a required one, or changing
what one returns is a breaking change and waits for 2.0.0.

### Added

- **Agent core** — the input → model → tools → answer loop, with a declarative
  persona, tools validated by Zod schemas, and conversation state that survives
  a restart.
- **Model gateway** — routing by task kind (`routing`, `simple`, `reasoning`,
  `sensitive`) across providers, with retries on transient failures, fallback
  between providers, per-call deadlines, and a cost row for every attempt.
  A `sensitive` route may never reach a cheap model. **A provider is
  configuration**: `config/models.json` declares which exist, where they are and
  which environment variable holds each key, so adding one is an entry in a file
  rather than a change to the harness. One adapter covers any OpenAI-compatible
  endpoint — most vendors, and a local runtime — and a second speaks Anthropic's
  native API, which the context compressor needs for explicit cache breakpoints.
- **Gateway resilience** — the gateway remembers what is broken, at the
  granularity of whose fault it is: a provider outage is everyone's and is held
  globally, a rate limit belongs to one key and is held per tenant. Recovery is
  a half-open probe, so a provider that is still down costs one request per
  cooldown rather than every request.
- **Bring your own model** — a tenant can pay their own provider on their own
  key, sealed under the same envelope as every other secret. Bringing a key opts
  that tenant out of the platform's: they are routed only to providers they have
  a key for, and a task with no covered candidate **fails** rather than falling
  back. `model_usage.billed_to` records whose money paid.
- **Modules and routing** — a module registry and a central router that decides
  on the cheap tier, with an eval framework to measure its hit rate before
  trusting it.
- **Human approval** — a tool marked `requiresApproval` pauses the turn before
  running anything; the pause costs no compute and survives a restart. Fails
  closed when no approval queue is wired.
- **Connections** — one resource-shaped contract (list/read/search/create/
  update/delete) with ten connectors: Confluence, Jira, GitHub, Google Drive,
  Slack, Notion, Google Calendar, Cal.com, Calendly and Microsoft Teams. OAuth
  mechanics with transparent token refresh, credentials sealed by envelope
  encryption (AES-256-GCM), and a read-through cache with polling and webhook
  invalidation.
- **MCP, both directions** — the connectors are exposed as tools over the Model
  Context Protocol (read-only by default), and a third-party MCP server can be
  consumed as an ordinary connector. Its session is scoped to one tenant and
  connection, never shared across tenants.
- **Context compression** — a gated engine pipeline that never lets a protected
  value come out wrong, measured in real tokens, aware of the provider's
  cacheable prefix, and off until an eval says answers hold.
- **Cross-module context** — a module asks, and the module that owns the data
  decides what to reveal. Opt-in per module, and it fails closed.
- **Traces** — every step of a turn recorded as it happens: input, routing
  decision, model calls, tools, the pause for a human, and how it ended. They
  can be exported as OpenTelemetry spans over OTLP/HTTP, without an
  OpenTelemetry SDK dependency.
- **Cost accounting** — spend per tenant, and broken down by model, task, day or
  session, with what compression saved reported separately.
- **Lifecycle** — draining a deploy without dropping the turn in flight, and the
  answers `/healthz` and `/readyz` should give. No endpoints and no signal
  handler are installed for you: a product owns its transport.
- **Tenants** — creating, finding and erasing the isolation boundary. Deleting a
  tenant cascades to everything it owns.
- **Secret redaction** — always on, over every path that writes to the database
  or a log.
- **Operator console** (`console/`) — a web console for seeing the harness:
  spend, recent turns step by step, and what is registered. Read-only in this
  release. It runs beside the database, binds localhost, and is a workspace of
  this repository rather than a separate product.

### Security

- Multi-tenant isolation is enforced by the schema, not only by the
  application, and `npm run isolation` refuses a migration that would weaken it.
- The agent never sees a credential: the connection layer resolves it at call
  time and hands it to a connector for the length of that call.
- **Writes exposed over MCP are gated.** MCP has no turn to pause, so a gated
  call is refused and recorded: it does not run, an approval is created, and the
  client is told to call again once a person has decided. The approval covers
  *those arguments*, so a changed input asks again. Enabling a write without
  wiring the queue now throws unless the product declares `ungated: true`.

### Known limitations

Written down rather than discovered later:

- **An MCP approval is not consumed.** `approved` is terminal, so a client
  holding the id can replay the *identical* write — same tool, same arguments.
  Single use needs a schema change and is deferred.
- **OAuth has been proven against mocks, not against a live provider.** The
  mechanics are covered by tests; the end-to-end flow with real credentials is
  the product's to run, and the console's Connections page (post-1.0) is what
  will exercise it.
- **`private: true` stays in `package.json`.** The package is not on npm; install
  by tag (`npm install github:yvesas/yas-harness#v1.0.0`). Publishing is a
  separate decision, not a side effect of tagging.
- **A turn has never been watched end to end through the console.** The agent
  loop is covered by tests and the playground renders, but no live model key has
  been used here — so routing, a model call, a tool and the trace have been seen
  working separately and not together in one screen.

[Unreleased]: https://github.com/yvesas/yas-harness/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/yvesas/yas-harness/releases/tag/v1.0.0
