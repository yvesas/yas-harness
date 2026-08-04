Model gateway: pick a model per task kind, with fallback and cost accounting.

Providers (Anthropic, Groq, ...) are adapters behind the ModelGateway port. Called directly, never through a third-party router.

## Bring your own model (E3)

A tenant can pay their own provider on their own key. Two different reasons a
customer asks: **money** (an enterprise with a negotiated rate would rather
spend it than pay a margin on ours) and **data** (a regulated one wants its
prompts landing in an account it holds a contract with, which is stronger than
any promise the platform can make about its own).

One rule carries the design:

> **Bringing a key is opting out of the platform's.**

- A tenant with **no** keys is routed exactly as before, on ours. Nothing about
  the pre-BYOM posture changes, and that is the default when no master key is
  configured.
- A tenant with **any** key is routed only to providers they have a key for. If
  no candidate for the task is covered, the call **fails**, and the message says
  so rather than reporting "no candidates".

Falling back would be the tempting alternative and is the one to avoid: it sends
that tenant's data to a provider they deliberately did not choose and bills us
for the privilege — and from the outside it looks exactly like success. The same
reasoning is why an unreachable key store raises instead of assuming "they have
none".

`ModelKeys` is split in two on purpose. `providers()` decides routing and must
never unseal anything; `resolve()` unseals for the **one** provider about to be
called, at the moment of the call. A request that lands on the first candidate
never decrypts the key for the second.

Keys are sealed under the tenant's existing data key (`tenant_keys`), so one
tenant has one DEK and revoking it covers everything they own. `model_usage`
carries `billed_to`, because a tenant on their own key must not be invoiced for
spend that was never ours — the cost is still recorded, since what a call cost
is worth knowing either way.
