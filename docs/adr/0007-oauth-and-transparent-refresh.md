# ADR 0007 — OAuth as mechanics, with transparent token refresh

- **Status:** accepted
- **Date:** 2026-07-23

## Context

Connectors reach sources that authenticate with OAuth 2.0 — Google, Atlassian
(Confluence), Notion. That means three things the connection layer has to do:
send a user to authorise, exchange the returned code for tokens, and keep the
access token fresh as it expires. The credential vault (ADR 0005) stores the
tokens; the connector contract (ADR 0006) runs operations with them; this slice
is how the tokens are obtained and kept working.

Two questions had to be settled: how much of the OAuth flow the harness owns,
and where token refresh happens.

## Decision

**The harness does the mechanics, not the web endpoints.** It builds the
authorization URL, exchanges the code, and refreshes the token — the parts that
are pure protocol. It does not run the HTTP endpoints a user's browser hits:
minting the `state`, redirecting the user, and receiving the callback are a
product's job. This is the same boundary as approval — the harness exposes the
pieces, the product wires the channel — and it is the right one, because the
harness is not a web server and the callback belongs to whatever surface the
product already has.

**Providers are declared as configuration.** A connector's OAuth provider —
endpoints, client id, scopes, extra params — lives in `config/connectors.json`,
keyed by connector id, so adding an integration is editing config. The one
thing that must not be in the file is the client secret: it is named there by
its environment variable and resolved at load time. A named secret that is not
set fails at startup, not at the first token exchange.

**Refresh is transparent, inside an active connection.** A merely stale access
token does not change a connection's status. When the manager resolves a
credential, a resolver checks the token's expiry (with a skew, to avoid racing
it) and, if it is stale, refreshes it against the provider, stores the new token
back, and returns it. The connector — and the agent above it — only ever sees a
working token, and never knows a refresh happened.

**A connection becomes `expired` only when refresh actually fails.** If the
refresh token is gone or the provider rejects it, the token cannot be recovered
and the user must re-authorise. The manager catches that, sets the connection to
`expired`, and fails — so the next call fails fast rather than hammering the
provider. The status gate and the transparent refresh are thus complementary:
`active` means "usable, refreshing as needed"; `expired` means "needs a human".

**The resolver is a seam.** The manager takes a `CredentialResolver`, not the
vault directly. The default reads the vault as-is — right for a static API key.
The OAuth resolver adds refresh. A connector that does not use OAuth (no provider
config) has its stored credential returned untouched, so the two kinds coexist.

## Consequences

**What this buys.** A product wires two thin endpoints (start-auth and
callback) using `buildAuthorizationUrl` and `exchangeCode`, and never touches
refresh — it just happens. Tokens stay fresh without a background job; the
refresh rides on the next use. Secrets stay out of the repo. And the manager
stays agnostic: OAuth is one resolver behind an interface, not a special case
in the run path.

**What it costs.** Refresh on first use after expiry adds a round trip to that
one call — acceptable, and the skew window means it rarely lands exactly on a
user-facing request. Two concurrent calls on a connection whose token just
expired can both refresh; the vault store is last-writer-wins and both resulting
tokens are valid, so this is harmless but not deduplicated. And the harness does
not persist `state` for the authorization flow — the product owns that, which is
correct but is a thing the product must not forget (it is the CSRF defence).

**What is not solved here.** The web endpoints themselves (product-side). PKCE
is not implemented — the authorization-code-with-secret flow covers the
server-side connectors this phase targets; PKCE can be added to the client
without changing the shape. And provider quirks beyond endpoints and params
(unusual token responses, non-standard refresh) would need per-provider handling
the generic client does not have yet.

## Alternatives considered

**Run the OAuth callback inside the harness.** Fewer moving parts for a product.
Rejected: it makes the harness a web server, and the callback URL and session
belong to the product's surface, not the engine's. The mechanics-only split
keeps the harness a library.

**Refresh in a background job.** Keep every token fresh ahead of time.
Rejected as premature: it needs a scheduler and a way to enumerate every
connection, for a benefit — no refresh latency on first use — that the skew
window mostly already provides. Refresh-on-use is simpler and has no moving
parts to run.

**Put the client secret in the config file.** Simplest to load. Rejected
outright: it would commit a secret, or force the file out of version control and
lose the point of declaring connectors as config. The env-var indirection keeps
the declaration in the repo and the secret out of it.
