# `src/telemetry/` — what a turn cost, and what it did

Two records, deliberately separate, because they answer different questions and
have different lifetimes.

- **`model-usage.ts` — what it cost.** One row per model attempt, failures
  included, priced from the model that answered. A usage row **outlives a
  deleted conversation** (it only clears `session_id`): the money was still
  spent, and spend history is what an operator reconciles against a bill.
- **`trace.ts` — what happened.** One row per step of a turn: the input arrived,
  the router chose, a model answered, a tool ran, a human was asked, the turn
  ended. A trace carries the user's own words and a tool's input, so it is the
  opposite — **deleting the conversation deletes it.**

## Boundary

- **Ports, with two adapters each.** `UsageRecorder` and `TraceRecorder` both
  have a Postgres adapter and an in-memory one, so everything above them is
  testable without a database.
- **Recording never breaks a turn.** Both paths catch their own failures and
  carry on: losing a row costs visibility, losing the user's turn would cost
  more.
- **Both are off unless wired.** No recorder means no rows and no branch in the
  caller — a `TurnTrace` without one is a no-op.
- **Nothing free-form is stored in the clear.** A step's `detail` and
  `errorMessage` go through the redactor (`src/redaction/`) on the way in.
  `label` does not need it: that is a name the harness chose — a module id, a
  tool name, a model.

## Shape of a trace

A trace is a **flat, ordered list** of steps sharing a `traceId`, not a tree.
Flat is enough to reconstruct a turn, cheap to append to as it happens (a turn
that dies half way still shows how far it got), and maps onto a span list — the
fields are deliberately span-like: an id, an ordinal, a kind, a duration, an
outcome. An OpenTelemetry exporter is a later slice and needs no schema change.

`sequence` carries the order, not `created_at`: `now()` is the transaction
timestamp, so steps written together would share a value and sort arbitrarily.

A caller may pass a `traceId` into both `Router.route` and `Agent.run`, so a
routing decision and the turn it chose read as one trace instead of two.
`RouteDecision` returns the id it used, which is the easy way to do it.
