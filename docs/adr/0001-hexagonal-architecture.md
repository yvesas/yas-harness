# ADR 0001 — Ports and adapters for the harness core

- **Status:** accepted
- **Date:** 2026-07-21

## Context

The harness is the shared engine behind several products, and each product
forks it. Three things are certain to change over its life:

- **Model providers.** The gateway is deliberately our own, calling providers
  directly. Adding a cheap tier, or letting a customer bring their own key,
  must not touch the agent loop.
- **Storage.** Sessions are in PostgreSQL today. A product that self-hosts may
  want something else.
- **Business modules.** They live in the products, not here, and they attach to
  the harness rather than being wired into it.

The core also has to be testable without a network. An agent loop that can only
be exercised by paying an API bill will not be exercised.

## Decision

The harness core depends on **interfaces (ports)** and never on
implementations. Providers, stores, channels and connectors are **adapters**
behind those ports, and they are wired together in a single composition root
(`src/index.ts`).

Ports defined so far:

| Port | Adapters today |
| --- | --- |
| `ModelGateway` (`src/models/model-gateway.ts`) | `AnthropicGateway`, `ScriptedGateway` |
| `SessionStore` (`src/memory/session-store.ts`) | `PostgresSessionStore`, `InMemorySessionStore` |

Two rules keep this honest:

1. Nothing under `src/core/` imports an adapter. The agent loop imports
   `ModelGateway` and `SessionStore`, never `AnthropicGateway` or `pg`.
2. Port vocabulary is provider-neutral. The port says `tool_call`, not
   `tool_use`; `TaskKind`, not a model id. Translation is the adapter's job —
   if a provider's word leaks into the port, the next provider inherits it.

## Consequences

**What this buys.** The whole agent loop is tested against `ScriptedGateway`
and `InMemorySessionStore` — no network, no database, no API bill, and the
tests are deterministic. Adding Groq is a new adapter and a routing rule, not a
change to the loop.

**What it costs.** A translation layer that has to be written and kept correct,
and a level of indirection between the code and the SDK. Two concrete
consequences we accepted:

- The port cannot express everything a provider offers. Extended thinking is
  the current example: it requires echoing provider-specific blocks back
  unchanged, so the Anthropic adapter drops those blocks and does not enable
  thinking. Supporting it means widening the port deliberately, not leaking the
  provider's shape through it.
- Test doubles are shipped in `src/`, not hidden in `tests/`. Products that
  fork the harness need them to test their own agents.

**How it can rot.** The rule fails quietly: one `import Anthropic` inside
`src/core/` and the boundary is gone with everything still compiling and
passing. That check belongs in CI before the codebase is big enough to hide it.

## Alternatives considered

**Call the SDK directly from the loop.** Less code today. Rejected because the
gateway's whole purpose is choosing between a cheap and a premium model, with
fallback — that logic has nowhere to live without a port, and the loop becomes
untestable offline.

**Use a third-party agent framework as the foundation.** Rejected in the
project plan: the harness is the product's differentiator, and inheriting
someone else's abstractions is inheriting their boundary decisions. They stay
as study references.
