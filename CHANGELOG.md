# Changelog

Notable changes to `yas-harness`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

Entries are **curated at release time** from the Conventional Commits on `main`
— see `.claude/skills/release-process/`. They are not a dump of the commit log:
a changelog is read by someone deciding whether to upgrade, so it records what
changed for *them*, not every commit that got there.

## [Unreleased]

Everything below is pre-1.0 and has never been tagged. Until `1.0.0`, the port
interfaces should be treated as unstable.

### Added

- **Agent core** — the input → model → tools → answer loop, with a declarative
  persona, tools validated by Zod schemas, and conversation state that survives
  a restart.
- **Model gateway** — routing by task kind (`routing`, `simple`, `reasoning`,
  `sensitive`) across providers, with retries on transient failures, fallback
  between providers, per-call deadlines, and a cost row for every attempt.
  Anthropic and Groq adapters. A `sensitive` route may never reach a cheap model.
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
- **MCP server** — exposes the connectors as tools over the Model Context
  Protocol, read-only by default.
- **Context compression** — a gated engine pipeline that never lets a protected
  value come out wrong, measured in real tokens, aware of the provider's
  cacheable prefix, and off until an eval says answers hold.
- **Cross-module context** — a module asks, and the module that owns the data
  decides what to reveal. Opt-in per module, and it fails closed.
- **Traces** — every step of a turn recorded as it happens: input, routing
  decision, model calls, tools, the pause for a human, and how it ended.
- **Tenants** — creating, finding and erasing the isolation boundary. Deleting a
  tenant cascades to everything it owns.
- **Secret redaction** — always on, over every path that writes to the database
  or a log.

### Security

- Multi-tenant isolation is enforced by the schema, not only by the
  application, and `npm run isolation` refuses a migration that would weaken it.
- The agent never sees a credential: the connection layer resolves it at call
  time and hands it to a connector for the length of that call.

[Unreleased]: https://github.com/yvesas/yas-harness/commits/main
