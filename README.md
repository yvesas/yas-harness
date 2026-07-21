# yas-harness

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

**A reusable agent chassis.** It receives messages, routes them, runs tools,
connects external services, asks for human approval and switches AI models —
so that every product built on top of it does not rebuild that plumbing.

It is the common engine behind the YAS Labs products. Products fork this
repository and add their own business modules on top.

> **Status: early development.** The foundation is in place; the agent core is
> being built. Not ready for production use.

## The golden rule

**The harness knows no product domain.** It knows how to route, connect,
execute, approve and switch models. It does not know what a "customer", an
"expense", a "meeting" or a "vocabulary word" is — those are business rules,
and they live in the modules that products register.

> If a piece of code would not work identically in a language tutor and in a
> CRM, it does not belong in the harness.

## What it provides

| Capability | What it means |
| --- | --- |
| Agent loop | input → decide → call model → run tools → respond |
| Central router | Picks the module that handles a given input, using a cheap model |
| Module registry | A module declares what it does and which tools it exposes |
| Connection layer | OAuth with token refresh, encrypted credentials, per-tenant isolation |
| Human approval | Any action can require an explicit OK before it runs |
| Model gateway | Cheap / premium / bring-your-own-model, routed by task kind, with fallback |
| Memory | Conversation context that survives restarts |
| Pools & permissions | Each module owns its data; cross-module access is asked for, never taken |
| Observability | A trace of every step and the cost of every model call |

## Requirements

- Node.js 22 or newer
- Docker (for PostgreSQL with pgvector)

## Getting started

```bash
git clone https://github.com/yvesas/yas-harness.git
cd yas-harness
npm install                 # also enables the Git hooks
cp .env.example .env

docker compose up -d        # PostgreSQL + pgvector
npm run migrate up          # create the schema
npm run check               # lint + typecheck + tests
```

## Scripts

| Command | What it does |
| --- | --- |
| `npm run dev` | Run the harness with reload on change |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Run the test suite |
| `npm run check` | Lint, typecheck and test — run this before committing |
| `npm run migrate up\|down\|status` | Apply, roll back or inspect migrations |

## Architecture

Hexagonal (ports and adapters): the harness domain sits in the centre, and
model providers, storage, channels and connectors are pluggable adapters. The
core depends on interfaces only, which is what makes it testable without a
network and what allows swapping a provider without a rewrite.

Multi-tenant from day one: every table holding user data carries `tenant_id`,
enforced by a database constraint rather than by application discipline alone.

Each folder under `src/` documents its own responsibility and boundary.

## Security

Credentials are encrypted and **the agent never sees API keys** — the
connection layer resolves them at call time, and the agent sees only method
names and results. Inbound messages from any channel are treated as untrusted
input. Destructive actions require human approval.

To report a vulnerability, read [SECURITY.md](./SECURITY.md) — please do not
open a public issue.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md), and
note that this project has an unusual rule: **commits must carry no AI
attribution or co-author trailers** — a hook enforces it.

## License

[Apache License 2.0](./LICENSE) — Copyright 2026 YAS Softwares LTDA.
See [NOTICE](./NOTICE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
