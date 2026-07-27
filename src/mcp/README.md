# `src/mcp/` — Model Context Protocol surface

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
  product opts in via `allow`. Wiring MCP writes through the human-approval
  queue is a later step.
- **No product domain.** It speaks `Resource`, the same in any product.

See [ADR 0009](../../docs/adr/0009-mcp-connectors.md).
