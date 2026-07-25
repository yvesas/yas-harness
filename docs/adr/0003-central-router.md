# ADR 0003 — A central router on the cheap tier, evaluated before trusted

- **Status:** accepted
- **Date:** 2026-07-22

## Context

A product built on the harness has several modules — finance, calendar, and so
on — and a user who talks to "one assistant". Something has to decide which
module handles a given message. The plan calls for this to start simple and
centralised, and to be cheap: triage is not work worth a premium model.

Two things had to be settled: how the decision is made, and how modules keep
their data without reaching into each other's.

## Decision

**A single central router.** Given an input and the registered modules, it asks
the cheap tier (`TaskKind: routing`) to choose one, and returns a
`RouteDecision` with a module id, a confidence and a reason. The reason and
confidence exist so the decision can be traced and evaluated, not just acted
on.

Design choices that follow:

- **One module short-circuits.** With a single module there is no decision to
  make, so the router returns it with confidence 1 and never calls the model.
  This is the common early case and it should cost nothing.
- **The model's choice is validated against the registry.** A cheap model will
  occasionally name a module that does not exist. That is a routing failure to
  surface, not a module to invent — the router throws rather than guessing.
- **Parsing is forgiving about wrapping, strict about shape.** A cheap model
  often wraps its JSON in prose or a code fence despite instructions. The router
  extracts the first balanced `{...}` object, then validates it against a
  schema. Forgiving where the model is sloppy, strict where correctness matters.

**Per-module pools, isolated by the primary key.** Each module gets a private
key-value space keyed by `(tenant_id, module_id, key)`. Isolation is the table's
shape, not a discipline the queries must remember: a query for one module's data
cannot return another's, and there is no code path that scopes by only one of
the two. A module never reads another's rows — crossing that boundary is done by
asking (phase 6), which this ADR does not cover.

**The router ships with its own eval.** A cheap router is only worth trusting
once its hit rate is measured, so the harness provides the way to measure it: a
versioned case set (`input → expected module`) and a runner that reports
accuracy. A case the router throws on counts as a miss, not a crash — finding
exactly that is the point.

## Consequences

**What this buys.** Routing is one cheap call, or none. The sensitive decisions
— an unknown module, a malformed reply — fail loudly instead of silently
picking wrong. Module data is isolated structurally, so a product cannot leak
one module's rows into another by forgetting a `WHERE` clause. And "is the
router good enough?" is a number a product can put a threshold on, not a
feeling.

**What it costs.** The router depends on the model returning parseable JSON of
the right shape; a model that cannot will fail every route, which is why the
eval is not optional. Centralised routing also does not scale to hundreds of
modules in one prompt — the catalogue grows with every module. That is a real
ceiling, deferred deliberately (below).

**What is not solved yet.** Cross-module context (module A asking module B for
something) is phase 6. Semi-autonomous modules that run their own inner loop are
sketched by the contract but not built. Neither changes the router's shape.

## Alternatives considered

**Keyword or rule-based routing.** No model call, fully deterministic. Rejected:
it cannot handle "how much did dinner set me back" without someone maintaining a
synonym list per module, and it degrades exactly where natural language is
messy — which is most of the time.

**Let every module see every message and opt in.** Decentralised, no router.
Rejected for now as the plan's own guidance: start centralised and simple, move
to decentralised only if it earns its complexity. The `ModuleDefinition`
contract does not preclude it later.

**Embeddings / semantic routing over module descriptions.** Scales past the
prompt-size ceiling and avoids a generation. Worth revisiting when the module
count makes the catalogue prompt expensive; overkill for the handful of modules
a first product has, and it trades a readable reason for a similarity score.
