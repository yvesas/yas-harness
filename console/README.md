# `console/` — the operator console

A web console for seeing the harness and driving it: what it spent, what it did
last turn, what is registered, and — in later phases — connecting a source over
OAuth, approving a gated tool, and talking to the agent.

It lives in this repository rather than its own. It is **one product**: the
console with no harness is an empty page, and a harness nobody can see is a
library with a promise. One repo means one version, one CI, one governance
setup, and no drift to manage between them.

## Why it exists, beyond being useful

The harness decided **three times** that it owns the mechanics and not the
transport — OAuth ([ADR 0007](../docs/adr/0007-oauth-and-transparent-refresh.md)),
the resource cache ([0008](../docs/adr/0008-resource-cache.md)), MCP
([0009](../docs/adr/0009-mcp-connectors.md)). Those are three loose ends with no
owner. The console is the product that ties them, so it completes the posture
rather than violating it.

And it is a **boundary test that costs less than a real product**. Every place
this console needs a raw `pool.query()` instead of a port is a gap in the
harness. It has already found one: there was no way to see which tools are
gated for approval without holding the tool definitions — which means holding
`execute`. That became `ToolRegistry.list()`.

## Running it

```bash
npm install                # from the repository root; the console is a workspace
npm run migrate up         # the console reads a schema, it does not create one
npm run console            # http://127.0.0.1:4100
```

`CONSOLE_TENANT_SLUG` picks the tenant (default `console`). The tenant must
already exist — the console **fails** rather than creating one, because a
console that mints the thing it is meant to be showing you renders an empty
dashboard that looks like a working one.

## Rules it holds to

- **It edits files; it does not replace files with a database.** Configuration
  stays in `config/*.json`, versioned in Git. When the config editor arrives it
  will validate with the harness's own parsers and write the file — never become
  the only way in. (Not built yet; phase 4.)
- **Secrets never enter the write path.** `MASTER_ENCRYPTION_KEY` and provider
  keys live in the environment. The console will show *defined / not defined*,
  never the value.
- **Localhost by default.** It holds the master key and sits beside the
  database. `next dev`/`next start` bind `127.0.0.1`; exposing it is a
  deliberate act that needs the authentication this version does not have.
- **Not on a managed platform.** It runs beside its Postgres —
  `output: 'standalone'`, an ordinary Node image. Next is the framework here,
  not the hosting.
- **One `currentTenant()`.** There is no login yet, and exactly one function
  answers who we are acting as, so adding real authentication is a change in one
  place rather than a hunt through forty files.

## What is here now (phase 0)

Read-only: **Overview**, **Traces** (list and one turn step by step), **Cost**,
**Modules**. Plus the two demonstration modules the pages need — `notes` and
`links` — which are also the only place this console presses on the Golden Rule.

The **Cost** page states what it cannot show (per model, per day, per session)
rather than rendering the one aggregate as though it were the whole story. That
gap is F6.6, and leaving the page to ask for it is deliberate: a port added
because a page might one day want it is a port shaped by a guess.

Still to come: Connections (phase 1), Approvals (2), Playground (3), Config (4),
Evals (5).
