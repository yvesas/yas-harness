# Architecture

The harness is a reusable agent chassis. It receives messages, routes them,
runs tools, picks a model, records cost, and (soon) asks for approval and
connects external services. Products fork it and add business modules on top.

## The golden rule

**The harness knows no product domain.** It knows how to route, execute, store,
price and approve. It does not know what a "customer", an "expense" or a
"vocabulary word" is — those are business rules, and they live in the modules
that products register.

> If a piece of code would not work identically in a language tutor and in a
> CRM, it does not belong in the harness.

This is not a convention. `npm run boundaries` fails the build if a source file
under `src/` names a product-domain word, or if the core imports an adapter.

## Ports and adapters

The core depends on **interfaces (ports)**, never on implementations.
Providers, stores and connectors are **adapters** behind those ports, wired
together in one composition root (`src/index.ts`). Nothing under `src/core/`
imports an adapter. See [ADR 0001](./adr/0001-hexagonal-architecture.md).

| Port | Defined in | Adapters |
| --- | --- | --- |
| `ModelGateway` | `src/models/model-gateway.ts` | `RoutedGateway`, `ScriptedGateway` |
| `ModelProvider` | `src/models/model-provider.ts` | `AnthropicProvider`, `GroqProvider` |
| `SessionStore` | `src/memory/session-store.ts` | `PostgresSessionStore`, `InMemorySessionStore` |
| `PoolStore` | `src/pools/pool-store.ts` | `PostgresPoolStore`, `InMemoryPoolStore` |
| `ApprovalStore` | `src/approval/approval-store.ts` | `PostgresApprovalStore`, `InMemoryApprovalStore` |
| `ConnectionStore` | `src/connections/connection-store.ts` | `PostgresConnectionStore`, `InMemoryConnectionStore` |
| `CredentialStore` / `TenantKeyStore` | `src/connections/credential-vault.ts` | Postgres and in-memory |
| `UsageRecorder` | `src/telemetry/model-usage.ts` | `PostgresUsageRecorder`, `InMemoryUsageRecorder` |

Every port has an in-memory or scripted adapter shipped in `src/`, not hidden
in `tests/` — products that fork the harness need them to test their own agents
without a network or an API bill.

## The layers

```
                    ┌──────────────────────────────────────────┐
   product ───────▶ │  Router        picks a module (cheap tier) │
                    │  Agent loop    input → model → tools → out │
                    └──────────────┬─────────────────┬──────────┘
                                   │ ports           │ ports
                    ┌──────────────▼──────┐  ┌───────▼─────────────┐
                    │  ModelGateway       │  │  SessionStore       │
                    │   → routing, retry, │  │  PoolStore          │
                    │     fallback, cost  │  │  UsageRecorder      │
                    └──────────┬──────────┘  └───────┬─────────────┘
                               │ ModelProvider       │
                    ┌──────────▼──────────┐  ┌────────▼────────────┐
                    │ Anthropic  ·  Groq  │  │ PostgreSQL + pgvector│
                    └─────────────────────┘  └─────────────────────┘
```

| Folder | Responsibility |
| --- | --- |
| `src/core/` | Agent loop, tool registry, persona |
| `src/router/` | Central router and its eval |
| `src/modules/` | Module contract and registry (no business modules) |
| `src/models/` | Model gateway, provider port, routing config |
| `src/memory/` | Session and conversation state |
| `src/pools/` | Per-module data pools |
| `src/telemetry/` | Model usage and cost |
| `src/connections/` | External connectors, connections and the credential vault |
| `src/connections/connectors/` | Concrete connectors (Confluence, Jira, GitHub) and shared Atlassian plumbing |
| `src/approval/` | Human approval queue |

## The path of a message

1. **Route.** The router shows the registered modules' descriptions to the
   cheap tier and gets back a module id, a confidence and a reason. One module
   short-circuits with no model call.
2. **Load.** The agent reads the session's history from the `SessionStore`.
3. **Decide.** The agent calls the `ModelGateway` with the persona's system
   prompt, the history and the module's tools. The gateway picks a model for
   the task, retries transient failures, falls back to the next provider, and
   records what the call cost — attributed to the tenant and the conversation.
4. **Act.** If the model asked for tools, the agent runs them (validating input
   against each tool's Zod schema) and feeds the results back. If any tool in
   the turn is marked `requiresApproval`, the whole turn pauses: the agent
   records pending approvals and returns `awaiting_approval`, running nothing.
   A human decides, and `resume` continues from there. See
   [ADR 0004](./adr/0004-human-approval.md).
5. **Persist.** Every turn — the user message, each assistant turn, each tool
   result — is appended to the session as it happens, so a restart mid-turn
   loses the in-flight call but not the conversation. A paused turn's state
   lives entirely in the session and the approval queue, so the pause survives
   a restart and holds no process open.

## Multi-tenancy

Every table holding user data carries `tenant_id`, and isolation is enforced by
the database, not by application discipline:

- `messages` can only reference a session of the same tenant, via a composite
  foreign key.
- `model_usage` is scoped to the tenant, and keeps its billing row when a
  conversation is deleted.
- `module_pools` is keyed on `(tenant_id, module_id, key)`, so no query can
  span a tenant or a module boundary.
- `approvals` can only gate a tool call in a session of the same tenant, via a
  composite foreign key, and a decision moves a row atomically.

Integration tests prove each of these against the real schema, because an
in-memory double could agree with a wrong constraint.

## Security posture

- Credentials are stored sealed by envelope encryption — a master key wraps a
  per-tenant data key, which encrypts that tenant's secrets. Only the vault's
  `resolve` decrypts, and only the connection manager calls it, at the moment
  of an outbound call, handing the credential to a connector for the length of
  that call. The agent asks to read or edit a resource and gets the resource;
  it never sees a key. Adding a source (Drive, Confluence, Notion) is
  registering a connector against one resource-shaped contract — nothing else
  in the harness changes. For OAuth sources the harness does the mechanics
  (build the authorization URL, exchange the code, refresh the token) while a
  product wires the callback; a stale token refreshes transparently on next
  use, and a connection becomes `expired` only when a refresh truly fails. See
  [ADR 0005](./adr/0005-connection-layer-and-credential-vault.md),
  [ADR 0006](./adr/0006-connector-contract.md) and
  [ADR 0007](./adr/0007-oauth-and-transparent-refresh.md).
- We call model providers directly. A routing service would be a third party in
  the data path — every prompt and answer flowing through infrastructure we do
  not control — which is what the LGPD posture rules out. See
  [ADR 0002](./adr/0002-own-model-gateway.md).
- Inbound channel messages are treated as untrusted input.
- Destructive actions can require human approval: a gated tool pauses the turn
  until a human decides, and fails closed if no approval queue is wired.

## Engineering principles

SOLID, hexagonal, clean code, multi-tenant from day one — stated in full in
[`CONTRIBUTING.md`](../CONTRIBUTING.md) and enforced where they can be:
`npm run boundaries` for the golden rule and the port boundary, the type
checker for the contracts, and integration tests for the isolation guarantees.
