# `src/redaction/` — secret redaction

Scrubs secrets out of free text **before it is logged or persisted**. A product
never wants an API key, a token, a private key or a `password=` in a connection
string to land in a log line or a database row, even by accident.

## Boundary

- **Always-on, never discardable.** Unlike a compression engine — whose output
  the pipeline may throw away — redaction runs unconditionally on the
  persistence and log path. Losing the secret is the goal, not a risk.
- **Not compression, not the sensitivity gate.** Compression may drop text but
  never changes a value; the gate keeps protected values byte-perfect. Redaction
  deliberately destroys a value. They are wired on different paths for different
  reasons (cost vs security) and must not be conflated.
- **Provider-neutral, no product domain.** Shape-based rules for well-known
  credential formats; nothing here names a provider integration or a product.

## Pieces

- `secret-redactor.ts` — the `SecretRedactor` port (`redact(text) → text`) and
  `redactDeep`, which walks an arbitrary JSON-ish value redacting its string
  leaves (a pool value, a tool-call input) without knowing its shape.
- `regex-secret-redactor.ts` — the default: linear (no-ReDoS) rules for PEM
  blocks, JWTs, AWS / Google / GitHub / Slack / Stripe / OpenAI-style keys,
  Bearer tokens, URL credentials and labelled `password=` / `api_key:` values.

The redactor is injected at the composition root as a decorator over the session
store, pool store, approval store and usage recorder, and into the gateway's one
log site.
