# ADR 0002 — Our own model gateway, not a routing service

- **Status:** accepted
- **Date:** 2026-07-21

## Context

The harness needs to send work to different models: a cheap one for triage and
classification, a capable one for reasoning, and eventually a customer's own
key. It needs fallback when a provider is down, and it needs to know what each
call cost.

Services like OpenRouter do exactly this, and using one would have saved the
work in this phase.

## Decision

We call providers directly and route between them ourselves.

The layering is deliberate:

| Layer | Knows | Does not know |
| --- | --- | --- |
| `ModelProvider` (adapter) | One provider's API and wire format | Which model to use, retries, cost |
| `RoutedGateway` | Routing, retry, fallback, attribution | Any provider's wire format |
| `config/models.json` | Models, tiers, prices, route order | Nothing executable |
| Agent core | `TaskKind` | Everything above |

**Why not a routing service.** It would be a real third party in the data path:
every prompt and every answer, including whatever a user typed, would pass
through infrastructure we do not control and cannot audit. The harness is being
sold on LGPD posture and on our controlling the data path — putting an
intermediary in the middle contradicts the pitch. It also makes the provider
relationship, the rate limits and the billing someone else's.

**Why routing lives in configuration.** Model ids, prices and preference order
are the fastest-moving facts in this system. A price change or a new model
should be a reviewed config edit, not a code change and a release.

**Two rules are enforced rather than documented**, because both fail silently:

- A route may not name a model that is not defined. Otherwise the mistake
  surfaces only when that fallback is finally needed — during an outage.
- The `sensitive` route may not contain a cheap model, anywhere in the chain.
  Getting a financial answer wrong costs more than the tokens saved, and the
  failure looks like a merely worse answer rather than an error.

**Retry policy.** A rejected request fails the same way however often it is
sent, so only transient failures (rate limits, timeouts, provider faults) are
retried, with exponential backoff, then the next candidate. Each provider
adapter classifies its own errors, because only it can.

**Cost accounting.** One row per attempt in `model_usage`, including failed
ones — a provider that fails half the time is a fact worth seeing, and its
retries are part of the latency users feel. Cost is computed from the
configured price, and money is stored as `numeric`, never a float.

## Consequences

**What this buys.** Adding a provider is one adapter plus a config entry.
Nothing between us and the provider. Cost per tenant and per conversation is a
query, and the sensitive-work rule is a test rather than a convention.

**What it costs.** We own the translation for each provider, and each has its
own shape — Groq's OpenAI-compatible API puts tool results in their own
messages and tool arguments in a JSON string, which the adapter has to
reconcile with the port. We also own keeping `config/models.json` current: a
stale price makes the cost report quietly wrong, which is worse than missing.

**What is not solved yet.** BYOM (a customer's own key) needs per-tenant
provider credentials, which waits for the connection layer's encryption in
phase 5. Streaming is not supported: no product needs it yet, and adding it
changes the port's shape.

## Alternatives considered

**OpenRouter or a similar router.** Rejected on the data path argument above.
Worth studying for the routing patterns; not worth being in the middle of every
conversation.

**One provider only.** Simpler, and it defers the whole problem. Rejected
because the cost case for a cheap tier is the plan's own reasoning: triage
should not run on a premium model, and that decision needs somewhere to live
from the start.

**Hard-coded routing in TypeScript.** Rejected: it makes a price update a code
change, and it hides the sensitive-work rule inside a function instead of
stating it where an operator can read it.
