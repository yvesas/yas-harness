# yas-harness

[![License: Apache 2.0](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](./LICENSE)

**A reusable agent chassis.** It receives messages, routes them, runs tools,
connects external services, asks for human approval and switches AI models —
so that every product built on top of it does not rebuild that plumbing.

It is the common engine behind the YAS Labs products. Products fork this
repository and add their own business modules on top.

> **Status: 1.0.0.** The ports are stable from this tag on. The console is
> read-only so far, and OAuth has been proven against mocks rather than a live
> provider — see the known limitations in
> [`CHANGELOG.md`](./CHANGELOG.md).

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
| Human approval | Any tool the agent runs can require an explicit OK first |
| Model gateway | Any provider, routed by task kind — cheap for triage, strong for reasoning — with fallback and bring-your-own-key |
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

### Talk to it

`examples/chat.ts` is a terminal chat against a real harness — the fastest way
to see the whole thing work. It runs a turn end to end: config, persona, model,
session, tools, the approval pause, the trace and the cost.

```bash
export PREMIUM_MODEL_API_KEY=...   # whatever config/models.json names them
export FAST_MODEL_API_KEY=...
npm run chat
```

### Use it from another project

The harness is a library. A product either **forks** this repository (the model
these docs assume) or **depends** on it:

```bash
npm install github:yvesas/yas-harness#v0.1.0
npx yas-harness-migrate up            # the schema ships with the package
cp -r node_modules/yas-harness/config ./config
```

```ts
import { createHarness } from 'yas-harness';

const harness = await createHarness();          // reads ./config and DATABASE_URL
const tenant = await harness.tenants.ensure({ slug: 'acme', name: 'Acme' });
```

> Not on npm: `private: true` in `package.json` is a deliberate guard, and
> removing it is a separate decision rather than something a release does on its
> own. Install by tag — `npm run package:check` proves the tarball installs and
> imports by name either way.

## Scripts

| Command | What it does |
| --- | --- |
| `npm run chat` | Terminal chat against a real harness (`examples/chat.ts`) |
| `npm run dev` | Run the harness with reload on change |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm test` | Run the test suite |
| `npm run check` | Lint, typecheck, **build** and test — run this before committing |
| `npm run package:check` | Pack, install into a throwaway project and import by name |
| `npm run isolation` | Prove the schema isolates tenants — every table, every key |
| `npm run migrate up\|down\|status` | Apply, roll back or inspect migrations |
| `npm run console` | The operator console, on `http://127.0.0.1:4100` |

## The console

`console/` is a web console for seeing the harness and driving it — spend,
recent turns step by step, what is registered, and (in later phases) connecting
a source over OAuth, approving a gated tool, and talking to the agent. It is an
npm workspace in this repository, because it is **one product**: a harness
nobody can see is a library with a promise.

It is also a boundary test that costs less than building a whole product on top.
Every place the console needs a raw `pool.query()` instead of a port is a gap in
the harness, and it has already found one. See [`console/`](./console/).

## Architecture

Hexagonal (ports and adapters): the harness domain sits in the centre, and
model providers, storage, channels and connectors are pluggable adapters. The
core depends on interfaces only, which is what makes it testable without a
network and what allows swapping a provider without a rewrite.

Multi-tenant from day one: every table holding user data carries `tenant_id`,
enforced by a database constraint rather than by application discipline alone.

Each folder under `src/` documents its own responsibility and boundary. For the
full picture — the layers, the ports and their adapters, the path a message
takes, and the decisions behind them — see [`docs/`](./docs/):

- [Architecture overview](./docs/architecture.md)
- [Architecture Decision Records](./docs/adr/)
- [Design decisions](./docs/decisions.md)

## Security

Credentials are encrypted and **the agent never sees API keys** — the
connection layer resolves them at call time, and the agent sees only method
names and results. Inbound messages from any channel are treated as untrusted
input.

A tool the agent runs can be marked `requiresApproval`: the turn then pauses
before running anything and waits for a person, and fails closed if no approval
queue is wired.

Writes exposed over **MCP** are gated differently, because MCP has no turn to
pause — it is request/response. There, a gated call is **refused and recorded**:
it does not run, an approval is created, and the client is told to call again
once a person has decided. The approval covers *those arguments*, so a changed
input asks again. Writes stay off by default, and enabling one without wiring
the queue is refused unless the product declares `ungated: true`.

To report a vulnerability, read [SECURITY.md](./SECURITY.md) — please do not
open a public issue.

## Releases

[`CHANGELOG.md`](./CHANGELOG.md) records what changed and what an upgrade asks
of you, including a **known limitations** section for each release — the things
worth knowing before you depend on it.

**From `1.0.0`, the ports are the contract.** Removing a method, adding a
required one, or changing what one returns is a breaking change and waits for
the next major.

## Contributing

Contributions are welcome. Start with [CONTRIBUTING.md](./CONTRIBUTING.md), and
note that this project has an unusual rule: **commits must carry no AI
attribution or co-author trailers** — a hook enforces it.

## License

[Apache License 2.0](./LICENSE) — Copyright 2026 YAS Softwares LTDA.
See [NOTICE](./NOTICE) and [THIRD_PARTY_NOTICES.md](./THIRD_PARTY_NOTICES.md).
