# `src/mcp/` — Model Context Protocol, both directions

**Exposing** (`mcp-server.ts`) — our connectors as MCP tools, for an MCP client
to reach. **Consuming** (`mcp-client.ts`) — somebody else's MCP server as a
source, reachable through the connector shape. Both sit on the same `Resource`
vocabulary, which is what makes either one a translation rather than a new idea.

## Exposing our connectors

Exposes the harness's connectors as **MCP tools**, so an MCP client (Cline,
Claude Code, another agent) can reach every connected source through one small
set of generic, resource-shaped calls — `list`, `read`, `search`, `create`,
`update`, `delete` — without knowing any source's API.

## Boundary

- **Mechanics, not a server process.** `McpServer.handle` maps one JSON-RPC
  request to one response. The product carries the bytes (stdio, HTTP) and
  resolves which tenant a session acts as, passing it in as context — the same
  split OAuth makes with its callback.
- **No dependency.** The protocol (JSON-RPC 2.0 + the few MCP result shapes) is
  hand-written in `protocol.ts`, like the connectors are written against `fetch`.
- **Safe by default.** Every call is tenant-scoped, and writes are off unless a
  product opts in via `allow` — and opting in now means saying what gates them.
- **No product domain.** It speaks `Resource`, the same in any product.

### Gating a write

MCP has no turn to pause, so a gated call is **refused and recorded**:

```ts
new McpServer(connections, {
  allow: ['create', 'update'],
  approvals: { store: harness.approvals, session: anchorSessionFor },
});
```

1. The call creates a `pending` approval and **does not run**. The client gets a
   tool result saying it is awaiting approval, with the id.
2. A person decides.
3. The client calls **again**; the decision is found and the call runs.

Refusing is the mechanism, not a failure: a client retrying is ordinary, and an
agent reading "awaiting approval" waits.

**The approval is for those arguments.** A request's identity is a hash of the
tool name and its canonical arguments — which is what lets the second call find
the first call's decision, and what stops a client getting approval for
something harmless and then sending something else.

**An approval is not consumed.** `approved` is terminal in `ApprovalStore`, so
the *identical* call can be replayed. Bounded by identical, and written down
rather than glossed over; single use needs a column and a migration.

Enabling a write with no `approvals` throws at construction unless you also pass
`ungated: true`. Both are legitimate; neither should be the one nobody noticed.

See [ADR 0009](../../docs/adr/0009-mcp-connectors.md) and its amendment.

## Consuming somebody else's server

`McpConnector` (in `src/connections/connectors/`, next to its siblings) makes an
MCP server an ordinary connector, so anything already speaking the protocol — an
internal wiki, a vendor's index, a team's own server — is reachable without a
connector being written for it.

```ts
const wiki = new McpConnector(new HttpMcpTransport({ url: 'https://wiki.internal/mcp' }), {
  id: 'mcp-wiki',
});
connectors.register(wiki);
```

It declares **`list` and `read`, and nothing else** — those are the two things
MCP's resource primitive offers. There is no resource search in the protocol,
and no create, update or delete; declaring one would fail at the first live call
against a real server. Writing over MCP is exposed by servers as *tools*, which
is a different surface and the decision MCP.4 is about.

### The two things this gets right on purpose

**A session belongs to one tenant.** MCP is stateful: `initialize` opens a
session with one tenant's credential, and a Streamable HTTP server hands back an
id carrying it. The cache is keyed by tenant **and** connection, never by
server — keying by server would hand tenant B a handle authorised as tenant A.

**The credential stays the vault's.** Nothing is cached here. Each call takes
the resolved secret from its `ConnectorContext`, hands it to the transport for
that one request, and forgets it — so a refreshed token is in use on the very
next call, and OAuth plus envelope encryption stay the source of truth.

### A third-party server is untrusted input

Its titles, descriptions and bodies are written by whoever runs it, and they
land in a model's context. Connecting one is a trust decision of the same weight
as installing a dependency, and it belongs to the product. What the client does
is refuse to let an answer be larger or stranger than declared: page sizes and
content lengths are capped, shapes are validated, and anything unrecognised is
dropped rather than forwarded.

**stdio is deliberately not shipped.** It means spawning a child process, and a
multi-tenant service spawning one per tenant has turned a connection into an
execution surface. A product that wants it writes that transport against
`McpTransport` in a dozen lines, and owns the decision.
