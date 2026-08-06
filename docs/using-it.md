# Using the harness

For running it. If you are working *on* it — changing the code, adding a
connector — the [README](../README.md) and the folder READMEs are the ones you
want.

## Start

```bash
git clone https://github.com/yvesas/yas-harness.git
cd yas-harness
./start.sh
```

That is the whole thing. The script checks Docker is installed and running,
checks the ports are free, writes a `.env` if there is none, generates the key
that seals your credentials, starts everything and waits until the console
answers. When something is missing it says which and what to do about it —
including how to install Docker on your machine.

Then open **http://localhost:4100**.

Stopping:

```bash
docker compose down       # stop, keep everything
docker compose down -v    # stop and erase the data too
```

## What you are looking at

A **harness** is the part of an AI product that is not the product: it takes a
message, decides which of your modules should handle it, calls a model, runs
the tools that model asks for, pauses when a person needs to approve something,
and records what it cost. The console is how you watch that happen.

| Page | What it answers |
| --- | --- |
| **Overview** | Is anything running, what did it cost, what failed |
| **Connections** | Which external sources are connected, and connect more |
| **Approvals** | What is waiting on a person |
| **Playground** | Talk to the agent, with the trace beside it |
| **Traces** | Every step of every turn |
| **Cost** | Spend by model, task, day and conversation |
| **Modules** | What is registered and what each can do |
| **Config** | Edit `config/*.json`, validated before it is saved |
| **Evals** | Is the cheap router still getting it right |

## Two things to set up when you want them

Neither is needed to start. The console tells you which is missing where it
matters, rather than failing.

### A model key

Only the **Playground** and **Evals** need one. Everything else — spend,
traces, connections, approvals — works without.

`config/models.json` declares which providers exist and **which environment
variable holds each key**. The shipped config names them by the role they play:

| Provider | For | Variable |
| --- | --- | --- |
| `premium` | Reasoning, and anything sensitive | `PREMIUM_MODEL_API_KEY` |
| `fast` | Triage and simple work | `FAST_MODEL_API_KEY` |

Put one in `.env` and restart. Who is behind each name is your choice: `fast` is
any OpenAI-compatible endpoint — Groq, Together, Fireworks, Cerebras, OpenAI, or
a local Ollama — and changing vendor is changing a base URL in
`config/models.json`.

### A connected source

**Connections** is where OAuth happens, and it is the reason the console exists:
a browser is the one thing a config file cannot do.

You need two things in place first.

**1. An OAuth app at the provider.** Start with GitHub — a free personal
account, no organisation, no review:

```
github.com → Settings → Developer settings → OAuth Apps → New OAuth App
```

Careful: **OAuth Apps**, not GitHub Apps. They sit next to each other and are
different things. The OAuth App form is small — four fields. If you see
Webhooks and Permissions, you are on the wrong one.

Set the callback to exactly `http://localhost:4100/connections/callback`.

**2. The provider in `config/connectors.json`.** Copy the entry you want out of
`config/connectors.example.json`:

```json
{
  "github": {
    "authorizationEndpoint": "https://github.com/login/oauth/authorize",
    "tokenEndpoint": "https://github.com/login/oauth/access_token",
    "clientId": "your-client-id",
    "clientSecretEnv": "GITHUB_CLIENT_SECRET",
    "scopes": ["read:user", "public_repo"]
  }
}
```

The secret is **named**, not written — `clientSecretEnv` says which variable
holds it, and the value goes in `.env`. The client id is not a secret.

Then restart and click **Connect**.

## Things that will trip you

**The callback URL must match byte for byte.** `localhost` and `127.0.0.1` are
different strings to a provider. Pick one, register it, browse to it.

**Refresh tokens differ per provider**, and this is where a connection silently
dies after an hour:

| | To get a refresh token |
| --- | --- |
| GitHub | Nothing — its tokens do not expire |
| Google | `access_type=offline` **and** `prompt=consent` |
| Atlassian | The `offline_access` scope |

`connectors.example.json` already carries the right parameters for each.

**A source stays in the list after you connect it.** Connecting again adds
another account rather than replacing the first. Name them and the list tells
them apart.

**Restart after editing `config/`.** The harness reads it at startup. The
Config page validates and writes; it does not reload a running process.

## What it does with your data

Worth knowing before you connect anything real.

- **Credentials are encrypted** with a key that lives in your `.env` and never
  in the database. The agent never sees them: the connection layer resolves a
  credential at the moment of a call and hands it to one connector for the
  length of that call.
- **Secrets are scrubbed** from everything written to the database or a log —
  traces, tool inputs, error messages.
- **Traces carry the user's own words**, so they are deleted with the
  conversation. Cost rows are not: the money was spent either way.
- **Everything is scoped to a tenant**, enforced by the database rather than by
  application care. Deleting a tenant cascades to everything it owned.
- **Nothing leaves your machine** except the calls you configured: your model
  provider, and the sources you connected.

## When something is wrong

```bash
docker compose logs console     # the console
docker compose logs postgres    # the database
docker compose ps               # what is running
```

The console shows the harness's own error rather than a generic page, because
it reads through the harness's ports and never around them. If a page says
something could not be answered, that sentence is the harness's answer.

## Known limits

Written down rather than discovered:

- **An MCP approval is not consumed.** A client holding the id can repeat the
  *identical* write.
- **There is no login.** One function decides which tenant the console acts as.
  It binds to localhost for that reason; do not expose it.
- **Config changes need a restart** to reach a running harness.
