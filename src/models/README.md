Model gateway: pick a model per task kind, with fallback and cost accounting.

Providers are adapters behind the ModelGateway port. Called directly, never through a third-party router.

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

## Adding a provider

There is nothing to add. A provider is **configuration**:

```json
{
  "providers": {
    "fast": {
      "kind": "openai-compatible",
      "baseUrl": "https://api.together.xyz/v1",
      "apiKeyEnv": "FAST_MODEL_API_KEY"
    }
  }
}
```

`openai-compatible` is one adapter for most of the market, because the vendors
converged on `/chat/completions`. It reaches Groq, Together, Fireworks,
DeepInfra, Cerebras, SambaNova, Mistral, xAI, OpenRouter, Nebius and OpenAI
itself; a local vLLM, Ollama or LM Studio; and Google's compatible endpoint. The
harness knows the wire format and nothing about whose endpoint is behind it.

`anthropic` is a second `kind` because that API is not that shape and has
features the compatible one lacks — explicit cache breakpoints among them. That
is the bar for a native adapter: **a capability the harness actually uses**, not
a logo. A vendor that is a fast, cheap endpoint does not need one.

Three things follow, and they are the point:

- **No vendor name appears in the harness's logic.** Names in this folder belong
  to adapter files, which have to say what they adapt — an anonymous adapter for
  a named API would be unreadable. The core, the ports and the composition root
  say nothing.
- **The key variable is named by configuration**, not fixed in code. A vendor's
  convention is the vendor's; two deployments of the same provider can use
  different variables.
- **A provider name is whatever the deployment calls it.** The shipped config
  names them `premium` and `fast` — by the role they play, not by who sells
  them, so swapping the vendor behind one changes a base URL and nothing else.
