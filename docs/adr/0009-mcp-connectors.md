# ADR 0009 — Expose connectors over MCP as mechanics, read-only by default

- **Status:** accepted
- **Date:** 2026-07-27

## Context

The Model Context Protocol (MCP) is becoming the common way for agents and
tools to talk to each other. The harness already has a uniform, resource-shaped
connector layer (ADR 0006) reaching Confluence, Drive, GitHub, Slack, Notion,
calendars and more. Speaking MCP would let any MCP client — Cline, Claude Code,
another agent — reach all of those through one protocol, without each learning a
source's API. The study of Cline (see `estudos/`) recommended **exposing our
connectors first** (high value, low coupling) and consuming third-party MCP
servers later.

Two questions had to be settled: how much of MCP the harness owns, and what an
MCP client is allowed to do once connected.

## Decision

**The harness provides an MCP server as mechanics, not a running server.**
`McpServer.handle` maps one JSON-RPC request to one response (or none, for a
notification). A product carries the bytes over stdio, HTTP or anything else.
This is the same split OAuth makes (ADR 0007): the harness does the protocol,
the product runs the transport. It keeps the harness a library, not a service.

**The protocol is hand-written, no dependency.** JSON-RPC 2.0 and the few MCP
result shapes live in `mcp/protocol.ts`. The surface used — `initialize`,
`tools/list`, `tools/call`, notifications — is small and stable, so a library
would mostly add a version to track and pull in a transport we do not want. This
is the same call the connectors make against `fetch`.

**Connectors are exposed as six generic, resource-shaped tools** — `list`,
`read`, `search`, `create`, `update`, `delete` — each taking a `connectionId`.
Because every connector already speaks the one `Resource` shape, a handful of
tools covers all of them; the alternative (per-connector tools) would grow with
every source and re-teach each API. Tool input schemas are derived from Zod with
`z.toJSONSchema`, the same one-definition-no-drift the agent tool registry uses.

**Every call is tenant-scoped, from context the product supplies.** `handle`
takes an `McpContext` with the `tenantId`; the product's transport resolves
which tenant a session acts as and passes it in. The harness never infers the
tenant, so a session cannot reach another tenant's connections — the isolation
the connection layer enforces holds across the MCP boundary too.

**Writes are off by default.** The server's `allow` list defaults to read-only
(`list`, `read`, `search`); `tools/list` advertises only the allowed tools and
`tools/call` refuses a disallowed one. Exposing a source over MCP therefore does
not silently hand out create/update/delete — a product enables writes as a
deliberate act. Write tools are also annotated `destructiveHint`.

**Errors split by whose fault they are.** A malformed request, an unknown
method, or a call to an unknown/disabled tool is a JSON-RPC error (the client
got the protocol wrong). Bad tool arguments and a connector operation that fails
come back as a **tool result** with `isError: true`, so an agent client sees the
message and can correct — the same "errors are results the model fixes" the tool
registry already follows.

## Consequences

**What this buys.** Any MCP client reaches every connected source through six
calls, with tenant isolation and a safe-by-default posture, and the harness
gains no server process, no dependency, and no new security model — it reuses
the connection manager (over the cache, so reads are cheap). The default harness
wires a read-only `McpServer`; a product opts into writes by constructing its
own with `allow`.

**What it costs.** The six generic tools are lower-level than purpose-built ones
(an MCP client works in resources and connection ids, not "create a Jira
issue"); richer per-connector tools could be layered on later. And the product
must wire the transport and resolve the tenant — correct, but a responsibility
it must not get wrong (the tenant mapping is the isolation boundary).

**What is not solved here.** Writes are gated by exposure, not yet by the
human-approval queue: a product that enables write tools should treat that as
it would any destructive tool. Wiring `tools/call` for a write through the
approval pause/resume (so an MCP client gets an "awaiting approval" and the
human decides) is a follow-up, as is **consuming** third-party MCP servers as an
optional adapter on the connection layer — kept for later so MCP stays an
interoperability bridge, not the internal mechanism.

## Alternatives considered

**Vendor the official MCP SDK.** Less protocol code and guaranteed conformance.
Rejected for now: it is a real dependency that bundles a transport (stdio/SSE
server), which pulls the harness toward being a server — against the library
boundary — and we would still adapt connectors to its API. The hand-written core
is small and keeps the transport the product's.

**Per-connector tools** (`create_jira_issue`, `read_drive_file`, …). More
discoverable and higher-level. Rejected as the first step: it grows with every
connector and leaks each source's vocabulary into the tool surface, undoing the
uniform contract's main benefit. The generic tools ship the whole connector set
at once; specific tools can be added on top without replacing them.

**Writes on by default.** Simpler to use. Rejected: it would let connecting a
source over MCP hand out destructive operations with no deliberate step, and the
approval integration **is now built** — see the amendment below.


---

## Amendment (2026-08-04) — MCP.4: writes are gated by refusing

The original decision left MCP writes outside the human-approval queue and said
so plainly: *"approval integration is not built yet. Read-only-by-default fails
safe."* That was honest but incomplete — a product that enabled writes got an
unattended write surface, and nothing said so at the moment it did.

**The agent loop's gate cannot be reused, and the reason is structural.** That
gate works by pausing a turn: the tool does not run, the turn is parked, and a
later call resumes it. MCP has no turn. It is request/response, and a request
that has not been answered is one timing out on somebody's socket.

So a gated call is **refused and recorded**:

1. It creates a `pending` approval and does not execute. The client is told, as
   a tool result, that the call is awaiting approval, and given the id.
2. A person decides.
3. The client calls **again**, the decision is found, and the call runs.

Refusing is the mechanism rather than a failure mode: an MCP client retrying is
ordinary behaviour, and an agent reading "awaiting approval" waits, which is
what should happen.

**The approval is for those arguments, not for that tool.** A request's identity
is a hash of the tool name and its canonical arguments. That is what lets the
second call find the first call's decision — the protocol hands out no id that
survives a retry — and it is also the security property: approving "create
`report.md`" approves exactly that, and a different input is a different
question. Keying on the tool name alone would let a client get approval for
something harmless and then send something else.

**Enabling a write is now a decision that has to be written down.** Listing a
write in `allow` with no `approvals` throws at construction unless the product
also passes `ungated: true`. Both are legitimate; neither should be the thing
nobody noticed. It fails at construction rather than at the first write, because
a check that only fires the day somebody deletes something is not a check.

### What this does not do

**An approval is not consumed.** `ApprovalStore` has no state for spending a
decision — `approved` is terminal — so a client holding the id can replay the
*identical* write. Adding single use means a `consumed_at` column and a
migration, and it was deliberately deferred. The exposure is bounded by
*identical*: the same tool, the same arguments — for a create, making the same
thing twice rather than something new.

**`approvals.session_id` stays `NOT NULL`.** An MCP call has no conversation, so
the product supplies a long-lived anchor session per tenant. Making the column
nullable was the obvious alternative and was rejected: it would break the
transitive tenant anchoring that `npm run isolation` enforces, trading a schema
guarantee for a convenience.
