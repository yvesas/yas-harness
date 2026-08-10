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

## Upgrading

Run `./start.sh` after pulling. It is safe to run any number of times and it
creates whatever a new version expects.

One upgrade needs saying out loud, because `git pull` does the damage before
you can read about it. **`config/models.json` used to be versioned and is now
yours**, so the commit that stopped tracking it *deletes your copy* when you
pull past it — it was a tracked file, and git removes tracked files it no
longer knows about. Nothing is lost that matters, but the console will not
start until there is a file there again:

```bash
./start.sh                                        # copies the example, or
cp config/models.example.json config/models.json  # the same thing by hand
```

The error names this fix too. If you had edited that file, the version you
edited is in the Git history up to that commit — `git show <commit>:config/models.json`.

Why it moved: which vendor answers your questions is not a choice this project
should make for you, and a file everybody inherits makes it one.

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
| **Agents** | Assemble an agent: model, prompt, sources it may reach |
| **Knowledge** | Documents everything you grant can search |
| **Evals** | Is the cheap router still getting it right |

## Two things to set up when you want them

Neither is needed to start. The console tells you which is missing where it
matters, rather than failing.

### A model key

Only the **Playground**, **Evals** and anything that actually runs an agent need
one. Everything else — spend, traces, connections, approvals — works without.

**Paste it on the Keys page.** That is the supported way: the key is encrypted
the moment it arrives, never reaches a file, never goes near Git, and is never
displayed again, including to you. Changing it is the same form. Nothing has to
be restarted — keys are read as they are used.

`.env` still works, and means something different: a key there belongs to the
**deployment** and is used by anyone who brought none of their own. That is
convenient when you are the only person using it, and wrong when you are running
this for other people.

Which providers exist, and which environment variable holds each deployment-wide
key, is `config/models.json` — **your** file, not in Git. The example ships two
providers named for the role they play rather than for who sells them:

| Provider | For |
| --- | --- |
| `premium` | Reasoning, and anything sensitive |
| `fast` | Triage and simple work |

Who is behind each name is your choice. `openai-compatible` covers most of the
market — Groq, Together, Fireworks, Cerebras, Mistral, xAI, OpenRouter, OpenAI
itself, Gemini's compatible endpoint, or a local Ollama or vLLM — so changing
vendor is changing a base URL. You can do it on the **Config** page, and it is
checked with the harness's own parser before it saves.

Two things that catch people:

- **A field ending in `Env` wants the *name* of an environment variable**, in
  upper case — `MY_MODEL_KEY`, not the key itself. A key pasted there is
  refused, and the error says to use the Keys page.
- **One key can be enough.** A tenant with any completion key of their own is
  routed only to providers they have a key for, so covering a single provider
  works as long as every route still has a candidate. What fails, deliberately,
  is a route with none — falling back would send your prompts to a provider you
  did not choose.

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

## Several agents in a row

One agent answering one question is the shape of a chat. Work is usually longer
than that: read the week's issues, draft the summary, and let somebody see it
before it is posted. That is a **workflow** — a file in `config/workflows/`,
one per workflow, versioned in Git.

```json
{
  "id": "weekly-summary",
  "name": "Weekly summary",
  "description": "Reads the week's work, drafts a summary, waits before posting.",
  "steps": [
    { "id": "gather", "agent": "research", "prompt": "Find everything in: {{input}}" },
    { "id": "draft", "agent": "research", "prompt": "Summarise:\n\n{{steps.gather}}" },
    { "id": "post", "agent": "publisher", "approve": true, "prompt": "Post:\n\n{{steps.draft}}" }
  ]
}
```

Three things about it are worth knowing before you write one.

**Steps do not share a conversation.** Each runs on its own, so one agent's tool
results never land in another agent's context. What crosses between them is
only what a prompt quotes with `{{steps.<id>}}` — which means you can read a
workflow file and know exactly what the third agent was told.

**`"approve": true` stops the run before the step.** Nothing has been sent to a
model yet; the decision is whether it should be. What waits in **Approvals** is
the prompt as it would be sent, with the draft already in it — not the template.
This is a different gate from an agent's own write approval, which holds a tool
call once the step is already running. Both can happen in one run.

**A waiting run costs nothing.** Its whole state is in the database, so nothing
is blocked and a restart in the middle loses only the step in flight. Approve
it a day later and it picks up where it stopped.

Copy `config/workflows/weekly-summary.json.example` to start. A workflow naming
an agent you have not created refuses to run and says which one is missing.

## Things that will trip you

**The callback URL must match byte for byte.** `localhost` and `127.0.0.1` are
different strings to a provider. Pick one, register it, browse to it.

**A 413 on the very first call is a per-minute budget, not a big message.**
Providers count the output ceiling you *ask for* against your tokens-per-minute
limit before reading a word of the prompt. The harness asks for 8000 by
default, so a model whose limit is 6000 refuses everything you send it — with
any prompt, immediately — and the message reads as though what you sent was too
big:

```
Request too large ... on tokens per minute (TPM): Limit 6000, Requested 8037
```

Give that model its own ceiling in `config/models.json`:

```json
"groq/instant": {
  "provider": "groq",
  "model": "llama-3.1-8b-instant",
  "tier": "cheap",
  "maxOutputTokens": 2000,
  "price": { "inputPerMTok": 0.05, "outputPerMTok": 0.08, "cachedInputPerMTok": 0.05 }
}
```

It belongs to the model rather than the provider because it depends on your
account's tier, and two models behind one key rarely share a limit.

**A small model will invent tool names.** An 8B-class model asked to use tools
sometimes calls one that was never offered, and a strict provider rejects the
turn outright:

```
tool call validation failed: attempted to call tool 'get_notebook_info'
which was not in request.tools
```

This is why the `routing` route can use a much cheaper model than `simple`:
routing asks for a JSON object in plain text, and nothing else. Anything
carrying tools — `simple`, `reasoning`, an agent with connections — wants a
model that handles them. If turns fail this way, move that route's first choice
up a size; the route order in `config/models.json` is the only thing to change.

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

**After editing `.env`, restart with `./start.sh`** — not `docker compose up -d`
on its own. Compose decides whether to recreate a container from the *service
definition*, and the contents of `.env` are not part of it, so a running
container keeps the environment it started with. That looks exactly like a key
not working. `./start.sh` forces the recreate; `docker compose up -d
--force-recreate` does the same if you prefer the long way.

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
- **Workflows run in a line.** No branches, no loops, no two steps at once. If
  a step fails, the run stops there rather than handing the failure to the next
  step as if it were content.
- **Nothing starts a workflow on a schedule.** Something has to press the
  button — the console, your own cron, a webhook you write.
