# ADR 0004 — Human approval as a pause, not a block

- **Status:** accepted
- **Date:** 2026-07-22

## Context

Some tool calls should not run unchecked — deleting data, sending a message,
anything hard to reverse or outward-facing. The plan calls for marking such
actions "requires approval": the agent pauses, a human decides, and only then
does the action run. Three things had to be settled: what "pause" means for a
process, how a decision is recorded, and what a half-approved turn does.

Until now, a tool marked `requiresApproval` failed closed — the agent refused
to run it. That was the right default to ship before the queue existed, but it
is not approval; it is refusal.

## Decision

**A pause is a return, not a block.** When a gated tool comes up, the agent
records pending approvals and returns with `stopReason: 'awaiting_approval'`.
The process does not stay alive waiting — no blocked promise, no timer. The
whole state of the pause lives in two tables already written each turn: the
`messages` (the assistant turn with its tool calls) and `approvals` (the
pending decisions). A later `resume` reads that state and continues. This is
what D3 — "pause without consuming resources" — actually requires: the pause
survives a restart and costs nothing while it waits.

**A turn is all-or-nothing.** If any tool call in a turn is gated, nothing in
that turn runs until the whole turn is settled — not even the ungated calls
beside it. Otherwise a half-run turn could be observed: the read happened, the
delete is still pending, and the model has seen one result but not the other.
On resume, the ungated calls, the approved gated ones, and error results for
the rejected ones are assembled into a single tool-result turn, in order —
which is also what keeps parallel tool calls working.

**The decision is atomic and auditable.** A decision moves a row from `pending`
only if it is still pending — the guard is in the `WHERE` clause, so two
operators deciding the same approval race on the database, and exactly one
wins. A schema check enforces that a decided row has a decider and a time, and
a pending row has neither: no silent approval, no decision by nobody. The
`approvals` table is therefore also the audit trail — what was asked, what was
decided, by whom, and why.

**A rejection is information, not an error.** A rejected tool call comes back to
the model as a tool result carrying the reason, so the model can change course
("understood, I will not delete it") rather than the turn simply failing.

**Fail-closed remains the default without a queue.** The approval store is an
optional dependency of the agent. A product that has not wired approval still
gets the old behaviour — a gated tool refuses to run — so nothing sensitive
runs unchecked by omission.

## Consequences

**What this buys.** A pause is free: no compute is held, and a decision can
come seconds or days later. The gate is enforced in the loop, so no tool
implementation has to remember to check. The audit trail is a table, not a log.
And the sensitive property — that a gated tool never runs undecided — is
covered by tests at both the store and the loop level.

**What it costs.** The turn model is now two entry points, `run` and `resume`,
and a product's transport has to call `resume` when a decision is made. The
paused state is reconstructed from the last assistant turn rather than held in
memory, which is what makes it restart-safe but means `resume` re-derives the
turn's tool calls each time. And "who decided" is an opaque string — the
harness does not model operators, so a product that needs real identities binds
them itself.

**What is not solved here.** Notifying an operator that something is waiting is
a product concern — the harness exposes the pending approvals, not a channel.
Timeouts on a pending approval (auto-reject after N hours) are not built;
nothing expires. And approval is per tool call, not per policy — "always allow
this tenant to read" is a rule a product layers on by choosing what to mark
`requiresApproval`.

## Alternatives considered

**Block the call until a decision arrives.** Simplest to write — `await` a
promise that resolves on decision. Rejected: it holds a process (and often a
connection) open for the entire human delay, which is exactly the resource cost
D3 rules out, and it loses the pause on any restart.

**Run ungated calls immediately, gate only the sensitive ones.** Less waiting.
Rejected: it lets a half-run turn be observed, and it complicates the
tool-result turn — the model would get some results now and some later, which
trains it away from parallel calls. All-or-nothing is simpler to reason about
and safer.

**A generic "interrupt" the model itself raises.** More flexible. Rejected as
premature: the need is concretely "these actions require a human", which
`requiresApproval` on the tool states plainly and a product controls. A general
interrupt mechanism can come if a second use for it appears.
