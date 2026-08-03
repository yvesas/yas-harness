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
outcome — which is what let the OpenTelemetry exporter be a translation and
nothing more.

`sequence` carries the order, not `created_at`: `now()` is the transaction
timestamp, so steps written together would share a value and sort arbitrarily.

A caller may pass a `traceId` into both `Router.route` and `Agent.run`, so a
routing decision and the turn it chose read as one trace instead of two.
`RouteDecision` returns the id it used, which is the easy way to do it.

## Exporting to OpenTelemetry

`toSpan` turns a step into an OTLP span; `OtlpTraceRecorder` is a decorator that
batches those to a collector over OTLP/HTTP. Set `OTEL_EXPORTER_OTLP_ENDPOINT`
and `createHarness` wires it — no code change, because that is the variable the
rest of an instrumented fleet already reads.

There is no OpenTelemetry SDK dependency. The harness is a library, so its tree
lands in every product whether or not that product exports anything, and what
the SDK would add is auto-instrumentation of things the harness does not do. A
product that wants the SDK still can: `toSpan` is a pure function, so feeding it
into an exporter this repository has never heard of is a few lines.

Worth knowing:

- **Spans leave as steps are recorded**, not read back from the table later —
  which is how OTel works, and needs no schema change. Wiring the exporter today
  does not send yesterday.
- **The exporter goes inside the redactor**, so what reaches a third party is
  scrubbed by the same pass as what is stored:
  `new RedactingTraceRecorder(new OtlpTraceRecorder(store, opts), redactor)`.
- **Ids are derived, not random** — `sha256(traceId:sequence)` — so a step
  exported twice is one span, and step 0 is the parent of the rest.
- **A collector that is down costs a batch, never a turn.** Failures are counted
  through `onError` and dropped; a full queue drops the oldest rather than
  growing until the process dies.
- **`close()` flushes.** `Harness.close()` already calls it, before the pool
  closes: the last spans of a turn usually explain why the process is going down.
