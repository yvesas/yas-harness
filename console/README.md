# `console/` — the operator console

A web console for seeing the harness and driving it: what it spent, what it did
last turn, what is registered, and — in later phases — connecting a source over
OAuth, approving a gated tool, and talking to the agent.

It lives in this repository rather than its own. It is **one product**: the
console with no harness is an empty page, and a harness nobody can see is a
library with a promise. One repo means one version, one CI, one governance
setup, and no drift to manage between them.

## Why it exists, beyond being useful

The harness decided **three times** that it owns the mechanics and not the
transport — OAuth ([ADR 0007](../docs/adr/0007-oauth-and-transparent-refresh.md)),
the resource cache ([0008](../docs/adr/0008-resource-cache.md)), MCP
([0009](../docs/adr/0009-mcp-connectors.md)). Those are three loose ends with no
owner. The console is the product that ties them, so it completes the posture
rather than violating it.

And it is a **boundary test that costs less than a real product**. Every place
this console needs a raw `pool.query()` instead of a port is a gap in the
harness. It has already found one: there was no way to see which tools are
gated for approval without holding the tool definitions — which means holding
`execute`. That became `ToolRegistry.list()`.

## Running it

```bash
npm install                # from the repository root; the console is a workspace
npm run migrate up         # the console reads a schema, it does not create one
npm run console            # http://127.0.0.1:4100
```

`CONSOLE_TENANT_SLUG` picks the tenant (default `console`). The tenant must
already exist — the console **fails** rather than creating one, because a
console that mints the thing it is meant to be showing you renders an empty
dashboard that looks like a working one.

## Rules it holds to

- **It edits files; it does not replace files with a database.** Configuration
  stays in `config/*.json`, versioned in Git. When the config editor arrives it
  will validate with the harness's own parsers and write the file — never become
  the only way in. (Not built yet; phase 4.)
- **Secrets never enter the write path.** `MASTER_ENCRYPTION_KEY` and provider
  keys live in the environment. The console will show *defined / not defined*,
  never the value.
- **Localhost by default.** It holds the master key and sits beside the
  database. `next dev`/`next start` bind `127.0.0.1`; exposing it is a
  deliberate act that needs the authentication this version does not have.
- **Not on a managed platform.** It runs beside its Postgres —
  `output: 'standalone'`, an ordinary Node image. Next is the framework here,
  not the hosting.
- **One `currentTenant()`.** There is no login yet, and exactly one function
  answers who we are acting as, so adding real authentication is a change in one
  place rather than a hunt through forty files.

## What is here now (phase 0)

Read-only: **Overview**, **Traces** (list and one turn step by step), **Cost**,
**Modules**. Plus the two demonstration modules the pages need — `notes` and
`links` — which are also the only place this console presses on the Golden Rule.

The **Cost** page asked for what it could not show, and got it: `UsageReader`
grew `breakdown` (by model, task, day and session) and `savings`. That is
**F6.6**, and it is the method rather than an exception — a port shaped by the
consumer that needed it, not by a guess about what a consumer might one day
want.

## Connections (phase 1)

The page that justifies the console existing: **OAuth needs a browser**, so it
is the one thing a config file and a script cannot do at all. The harness owns
the mechanics and leaves the callback to a product
([ADR 0007](../docs/adr/0007-oauth-and-transparent-refresh.md)) — this is that
product.

Phase 1 revealed a second gap, the same way phase 0 did: the harness had both
ends of the flow and nothing joining them. `ConnectionOnboarding` is the join —
authorization URL in, stored connection with a sealed credential out. Callers
name a **connector**, never pass an `OAuthProvider`, so a client secret does not
reach every surface that wants to render a button.

How `state` is kept, since it is the security-relevant part:

- 32 random bytes in an **HttpOnly cookie**, and the same value in the URL. They
  must match on the callback. **No signing key** — the cookie cannot be read or
  written from script, so an attacker cannot make one matching the URL they
  crafted; comparing a value they cannot see is enough.
- `SameSite=Lax`, because the provider returns with a top-level GET, which Lax
  allows and Strict would drop.
- Cleared whatever the outcome. A state that outlives its flow can be replayed.
- **Checked before the code is spent.** Trading first and validating afterwards
  would already have attached the account by the time the check fails.

Disconnecting erases the sealed credential and the connection. It does **not**
revoke the token at the provider — only the source can do that, and claiming
otherwise would leave a live token behind a console saying it is gone.

### Running a real flow

What you need, in order:

**1. A database.** The console reads the harness's schema directly.

```bash
docker compose up -d
npm run migrate up
```

**2. A master key.** Without it there is nowhere to seal a credential, and the
page says so instead of showing a broken button.

```bash
echo "MASTER_ENCRYPTION_KEY=$(openssl rand -base64 32)" >> .env
```

**3. A tenant.** The console **fails** rather than creating one — a console that
mints what it is meant to be showing you renders an empty dashboard that looks
like a working one.

```bash
node --experimental-strip-types -e "
  import('./dist/index.js').then(async ({ createHarness }) => {
    const h = await createHarness();
    console.log(await h.tenants.ensure({ slug: 'console', name: 'Console' }));
    await h.close();
  })"
```

**4. A provider.** In `config/connectors.json`, with the secret in the
environment — never in the file, which is in Git.

```json
{
  "google-drive": {
    "authorizationEndpoint": "https://accounts.google.com/o/oauth2/v2/auth",
    "tokenEndpoint": "https://oauth2.googleapis.com/token",
    "clientId": "${GOOGLE_CLIENT_ID}",
    "clientSecret": "${GOOGLE_CLIENT_SECRET}",
    "scopes": ["https://www.googleapis.com/auth/drive.readonly"],
    "authorizationParams": { "access_type": "offline", "prompt": "consent" }
  }
}
```

`access_type=offline` and `prompt=consent` are how Google is made to return a
**refresh token**. Without them the connection works for an hour and then stops,
which looks like the harness losing the credential rather than never having been
given one.

**5. The redirect URI, registered at the provider exactly as the browser will
send it.** The console derives it from the request rather than from config — a
value written in two places is one that will disagree — so whichever of these
you browse to is the one to register:

```
http://localhost:4100/connections/callback
http://127.0.0.1:4100/connections/callback
```

Google's console accepts both for a Web application client; some providers only
accept the `localhost` spelling. Pick one and stay on it: they are different
strings to a token endpoint, and a mismatch is rejected as
`redirect_uri_mismatch`.

Then `npm run console`, open **Connections**, and click connect.

### If it fails

- **`redirect_uri_mismatch`** — the URI you registered is not the one the
  browser is on. Check the scheme and the spelling of the host.
- **Connected, but stops working after an hour** — the provider granted no
  refresh token. See `access_type`/`prompt` above.
- **"the state does not match"** — the flow was started in a different browser
  or more than ten minutes ago. Start again from the Connections page.
- **"could not store the credential"** — the connection was undone on purpose;
  the master key or the database is the thing to look at.

Still to come: Approvals (2), Playground (3), Config (4), Evals (5).
