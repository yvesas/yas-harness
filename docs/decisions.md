# Design decisions

The smaller calls that shaped the code but are too narrow for an
[ADR](./adr/). One line each, newest first, with the reason. When a choice is
load-bearing enough that a future reader would re-litigate it, it becomes an
ADR instead.

## Router and modules

- **The router validates the model's choice against the registry.** A cheap
  model occasionally names a module that does not exist; that is a routing
  failure to surface, not a module to invent. It throws rather than guessing.
- **The router is forgiving about JSON wrapping, strict about shape.** A cheap
  model often wraps its reply in prose or a code fence; the router extracts the
  first balanced `{...}` object, then validates it against a schema. Forgiving
  where the model is sloppy, strict where correctness matters.
- **A single registered module short-circuits with no model call.** A routing
  decision with one option is not a decision, and it is the common early case.
- **The router eval is a required step, not a nicety.** A cheap router is only
  worth trusting once its hit rate is measured; the `adding-a-module` skill
  makes shipping a case set part of adding a module.
- **Pools are isolated by the primary key `(tenant_id, module_id, key)`**, so
  isolation is the table's shape rather than a discipline every query must
  keep. No query can span a tenant or a module boundary.
- **The in-memory pool store's methods are `async` with no `await`.** They do
  no I/O, but being async turns a rejected key into a rejected promise — the
  same shape the Postgres adapter has, and the shape callers expect.

## Models and cost

- **Routes, tiers and prices live in `config/models.json`, not in code.** They
  are the fastest-moving facts here; a price change should be a reviewed config
  edit, not a release.
- **The `sensitive` route may not contain a cheap model, anywhere in its
  chain** — validated at load. Getting a sensitive answer wrong costs more than
  the tokens saved, and the failure would look merely like a worse answer.
- **A route naming an undefined model is rejected at load**, not when that
  fallback is finally needed during an outage.
- **The Groq adapter is written against `fetch`, not a client library.** The
  surface used is three fields wide; a dependency would buy only a version to
  keep up with.
- **Only transient failures are retried** (rate limits, timeouts, provider
  faults), with exponential backoff, then the next candidate. A rejected
  request fails the same way however often it is sent.
- **`model_usage` records one row per attempt, failures included.** A provider
  that fails half the time is a fact worth seeing, and its retries are latency
  users feel.
- **Cost is stored as `numeric`, never a float**, and computed to sub-cent
  precision — most single calls cost fractions of a cent, and rounding to cents
  would report them as zero.
- **`model_usage` keeps its billing row when a conversation is deleted**, using
  `ON DELETE SET NULL (session_id)` (PostgreSQL 15+). A plain `SET NULL` on the
  composite key would also null `tenant_id`, which is `NOT NULL`, and the
  delete would fail.
- **Extended thinking is not enabled.** It requires echoing provider-specific
  blocks back unchanged, which the gateway port cannot express yet; the adapter
  drops those blocks rather than half-supporting the feature.
- **Context compression is a gated pipeline, and safe by construction (E5.1).**
  A `ContextCompressor` port compresses a `ModelRequest` through a priority-
  ordered set of engines (`compress` + `configSchema`, config validated at
  construction), each checked by a **sensitivity gate**: if an engine's output
  would drop or alter a protected value — money, a number, a date, an id, a URL,
  an email, or anything in code / a fenced block — the pipeline discards that
  output and keeps the last safe request. The floor is "no change", never "a
  wrong value" — the domain-agnostic guarantee the OmniRoute study lacked. The
  engines are lossless: `whitespace` (trailing-space and blank-line trim only)
  and `json-table` (a homogeneous JSON array of objects → a compact
  `{columns, rows}` table — drops repeated keys, keeps every value; if
  re-serialising would reformat a number, the gate discards it). Gate patterns
  are linear (no ReDoS). The whole strategy is
  [ADR 0010](./adr/0010-context-compression.md).
- **Compression savings are measured in real tokens, through a port (E5.4).**
  Tokens — not characters — are what a model bills, and no single tokenizer is
  exact for Claude, GPT, Gemini and Llama at once (each keeps its own vocabulary;
  some only expose a `count_tokens` API). So counting is a `TokenCounter` port: a
  product injects an exact per-provider counter when it needs one, and the harness
  ships a provider-neutral default, `GptTokenizerCounter` (real BPE via
  `gpt-tokenizer`, o200k_base — exact for OpenAI, a ~5-15% approximation for the
  others on English, offline so it can size a request before any call). The
  pipeline reports per-engine tokens before/after via the counter; it still
  decides "did the engine shrink it?" on characters (cheap and exact). This is
  measurement, not the fixed compression ratio OmniRoute assumed. Persisting the
  saving alongside `model_usage` waits for the gateway wiring (E5.5), where the
  provider's own usage numbers land next to it.
- **Lossy engines drop content, but the gate still catches corruption (E5.6).**
  The biggest real saving is in tool-result output (logs, dumps, retries), which
  needs *dropping* — truncation and dedup — not just rewriting. So an engine now
  declares itself `lossy`, and the gate applies in the matching direction: a
  lossless engine must keep every protected value (nothing dropped); a lossy one
  may drop values but must not **introduce** one that was not in the input — a
  mangled `$1,234.56 → $1` shows up as a token absent from the input and is
  discarded. The floor stays "safe drop", never "wrong value". The first lossy
  engine, `tool-result`, strips ANSI, collapses repeated consecutive lines, and
  truncates a long result to head+tail while keeping every error-looking line;
  an `isError` result is never truncated. It is in the `aggressive` profile only
  (`light`/`medium` stay lossless). Secret redaction is deliberately **not** here:
  it is security, must always run, and must never be a discardable engine — it
  belongs on the persistence/log path (a separate slice), not the cost pipeline.
- **The gateway remembers what is broken, at the granularity of whose fault it
  is (F6.7).** Retry and fallback worked but had no memory, so a provider down
  for an hour was still tried — and retried with backoff — on *every* request,
  each one paying the full timeout before the fallback it always needed. The
  memory is split because `retryable` cannot answer the question that matters:
  a **5xx or timeout is the provider's**, which is not a fact about one tenant,
  so that scope is global; a **429 is this key's**, which under BYOM is
  literally a different key per tenant, so that scope is `(tenant, model)`.
  Backing off the wrong one either punishes tenants who are fine or keeps
  hammering a provider that is down. Two behaviours follow: a rate-limited model
  is **not** retried immediately (the same key is still limited a second later,
  so the attempt buys nothing), and the provider's own `Retry-After` beats any
  cooldown we would compute, because it knows when its window resets. Recovery
  is a **half-open probe**, not a clock — when the cooldown expires exactly one
  request goes through as a test; success clears the memory, failure doubles the
  wait to a ceiling — so a provider still down costs one request per cooldown
  rather than all of them. A *rejected* request never trips anything: a bad
  request says nothing about a provider's health, and counting it would take a
  healthy provider out of service. The state is **in process on purpose**: it
  describes the last few seconds of a running gateway, and a restart should
  rediscover it rather than inherit a stale verdict — `Availability` is an
  interface so a deployment that wants it shared can implement one.
- **Isolation is checked in the schema and across both adapters (F7.3).** Every
  table already carried `tenant_id` and every cross-table key was already
  composite — the risk was never the tables that exist, which have their own
  tests, but the **next** one: a table added without a tenant, or with a key
  naming a row without naming its tenant, would let one tenant's data attach to
  another's while every existing test still passed. `npm run isolation` reads
  the migrations and refuses exactly that. Writing it corrected a rule rather
  than the code: `messages`, `approvals`, `credentials` and `resource_cache`
  anchor their tenant **transitively**, through a cascading composite key into
  `sessions` or `connections`, and that is *stronger* than a direct reference —
  a child's tenant cannot disagree with its parent's, because they travel in one
  key. **The in-memory adapters are the sharper risk**, because they exist so a
  product can test without a database: an adapter that leaks, or merely behaves
  differently, makes a product's whole suite a false pass. Sweeping them found
  two real defects — `InMemorySessionStore.messages` **threw** where Postgres
  returns empty, and `InMemoryTenantStore` threw **synchronously** instead of
  rejecting, breaking the rule the pool store already documents. Both fixed.
- **The package is importable, and a check proves it from the outside (F7.2c).**
  There were no `main`, `exports` or `files`, so the harness could be forked but
  never depended on — and a v1.0.0 tag of a library with no entry point is a
  strange thing to ship. The manifest now declares them, and the tarball carries
  what a consumer cannot work without: the built code **with types**, the
  `migrations` (a consumer has to create the schema), the migration runner as a
  `bin`, a starting `config/`, and `NOTICE`, which the Apache licence requires
  to travel with the code. **`private: true` stays** as the deliberate guard
  against an accidental publish; dropping it is the one-line switch at v1.0.0,
  and installing by git tag works meanwhile. `prepare` had to become
  `hooks && build` — npm runs it both before packing and after a git-URL
  install, so without a build there the tarball ships no `dist`; the git-hooks
  setup runs first so a developer with a broken build still gets the
  co-authorship guard. The check (`npm run package:check`, in CI) packs,
  installs into a throwaway project and imports **by package name**: every test
  here imports `src/` by relative path, so a broken exports map or a missing
  file passes the whole suite and fails on the first consumer.
- **`npm run check` builds before it tests.** The console's own tests import
  `yas-harness` **as built**, because that is how the console imports it — so
  they run against `dist/`, and `dist/` is only as fresh as the last build.
  Changing a parser and running `check` therefore passed locally against
  yesterday's output and failed in CI, which compiles on install. A gate that
  can be green on stale artefacts is not a gate; the build now runs first, and
  the local command exercises what CI does.
- **`start.sh` forces a recreate, because `.env` is not part of what compose
  watches.** Compose decides whether to rebuild a container from the *service
  definition*; the contents of an `env_file` are not in it. So adding a key to
  `.env` and running `docker compose up -d` leaves the running container with
  the environment it started with — which looks exactly like the key not
  working, and is the next thing anybody does after being told to put a key in
  `.env`. Found by testing that path before somebody walked it: the container
  kept a stale value across two `up -d` calls, same creation timestamp both
  times. A recreate costs seconds and the script exists so this never happens.
- **The central agent delegates to the module the router chose.** Doc 13's
  decision 3 says that under centralised orchestration one thing holds from the
  start: *"o central delega, não microgerencia"*. It did not. `AgentTurn` had no
  `moduleId`, the word "module" appeared nowhere in `agent.ts`, and the console
  passed the decision's `traceId` while dropping its `moduleId` — so the router
  chose correctly, the choice was traced, and the turn then ran with every
  module's tools flattened together. A note-taking module could send an email
  because some other module could. A turn now resolves a **scope** — tools,
  instructions, task kind, iteration limit — once, from the module or from the
  agent's own dependencies, and the loop reads that instead of the instance
  fields. Three rules: **instructions are appended, never substituted**, because
  a module that can replace the system prompt can quietly undo the product's
  voice, language and safety rules; **everything is additive**, so a module with
  no `agent` block, a turn with no `moduleId` and an agent with no registry all
  behave exactly as before; and **an unknown module fails the turn** rather than
  falling back to everything, because a plausible answer from the wrong thing is
  the failure nobody notices.
- **A failed turn is an answer, not a crash — and the console owns its error
  screen.** Sending a message with no model key configured let the error out of
  the server action, which replaced the whole page with Next's own "This page
  couldn't load" — losing the conversation, the trace showing how far the turn
  got, and the input box, and showing a screen with none of the console's
  styling at the exact moment the system stopped being legible. Two fixes, and
  they are different in kind. The action now **catches**: a turn failing is
  ordinary here — an absent key, a provider refusing, a tool throwing — so it
  surfaces beside the input while the page stays intact. And `app/error.tsx`
  plus `app/global-error.tsx` mean anything that still escapes lands somewhere
  that looks like the console and offers the two things that help, try again or
  go somewhere that works. The global one renders plain on purpose: it is the
  layout itself failing, so there is no theme to rely on, and it says that
  rather than pretending. Separately, the nav now marks the page you are on, by
  **prefix** rather than equality, so `/traces/<id>` lights up Traces.
- **The harness exposes the configuration it loaded, because "am I set up?"
  had no answer.** `createHarness` read `config/models.json`, built a gateway
  from it and dropped it — so nothing could say *which* key was missing, and the
  name is the deployment's own (`apiKeyEnv`), not one a page could guess. It is
  now `harness.models`, read-only, carrying no secret: a variable's name is not
  its value. The console's Home assembles the whole picture from ports —
  `readiness` for the database, `vault` and `onboarding` for what a master key
  unlocks, `models` for what was configured to route to — instead of each page
  discovering its own prerequisite the hard way. **A missing option is not a
  fault**: an absent model key is `optional`, not broken, because everything
  except the playground and the evals works without one and colouring it red
  teaches people to ignore red. It is also the first consumer `readiness` has
  had; it was built for `/readyz` and used by nothing, which is how a port rots.
- **The console uses shadcn/ui with the Claude theme, and doc 21 said when.**
  That document deliberately left the UI library to "the first screen that
  genuinely needs it", which is a good way to avoid choosing early and a bad way
  to never choose. The screen arrived when the console stopped being a way to
  *check* the harness and became the way to *use* it. Three things follow.
  **Components are copied in, not depended on** — that is what shadcn is, so
  `console/components/ui/` is ours to edit and there is no library version to
  chase. **The theme is CSS variables** in `globals.css`, generated from a
  registry; it is regenerated rather than hand-edited, and the file says so.
  **Light and dark default to the system's**, through `next-themes` rather than
  a `useState`, for the one reason worth a dependency: it writes the class
  before the first paint, and a console somebody keeps open all day should not
  flash the wrong theme at them. The migration was mechanical enough to script,
  which is how it stayed a styling change rather than a rewrite — the copy on
  every page is untouched.
- **A server action that changes what a page shows has to say so.**
  Disconnecting removed the connection and the page kept rendering the list it
  had, so somebody who had just disconnected needed a refresh to believe it. The
  page is `force-dynamic`, which was the reason it looked covered — but that
  decides whether a page is *cached*, not whether an action's result reaches the
  client. Three of the four actions already called `revalidatePath`; this one
  was the omission. It also redirects to a clean URL, since the outcome banner
  lives in the query string and landing back on `?connected=github` after
  disconnecting it would leave a success message announcing what was just
  undone.
- **Scopes are split on space *or* comma, because the specification and GitHub
  disagree.** RFC 6749 §3.3 says a granted `scope` is space-separated; GitHub
  answers with commas. Splitting on the specification alone stored a single
  scope named `"public_repo,read:user"` — one string that renders correctly on a
  page and is wrong in every comparison, which is the worst way for data to be
  wrong. Splitting on either is safe rather than lax: the RFC draws scope tokens
  from a character set excluding both, so neither can appear *inside* a scope
  and neither split can cut one in half. Found by connecting a real account —
  no mock had disagreed with the specification, because the mocks were written
  from it.
- **The OAuth callback is a Route Handler, and the real flow is what said so.**
  It was a page, on the reasoning that a provider sends a *person* to the
  callback rather than a machine. That is true of the rendering and beside the
  point for the state cookie: finishing a flow **clears** it, clearing is a
  mutation, and Next permits mutations in a Route Handler or a Server Action and
  nowhere else. Every test passed, the page rendered, and the first real
  authorization failed on it — with the code and state sitting in the URL,
  having worked. The handler now does the exchange and redirects back to
  Connections carrying the outcome in the query string: there is nothing secret
  in a connector id, the scopes granted, or why it failed, and a URL somebody
  can re-read, screenshot or paste into a bug report is worth more than a
  message that vanishes on refresh. It also lands them on the list that now
  includes what they just connected.
- **A provider is configuration, not a file in `src/models/`.** The ports were
  always vendor-neutral, but the composition root was not: it read
  `if (routed.has('anthropic'))`, so adding a provider meant editing the
  harness. `config/models.json` now declares them — kind, base URL, and **which
  environment variable holds the key** — and the harness builds what it is told
  to. Three consequences. **One adapter covers most of the market**: the vendors
  converged on `/chat/completions`, so `OpenAiCompatibleProvider` reaches Groq,
  Together, Fireworks, Cerebras, Mistral, xAI, OpenRouter, OpenAI itself, a
  local vLLM or Ollama, and Google's compatible endpoint — parameterised by base
  URL, knowing the wire format and nothing about whose endpoint is behind it.
  **A native adapter needs a capability, not a logo**: `anthropic` stays a
  separate kind because that API is a different shape and has explicit cache
  breakpoints the harness uses; a vendor that is merely a fast, cheap endpoint
  does not get one. **The key variable is named by configuration**, since a
  vendor's convention is the vendor's and hardcoding one is picking a vendor.
  The shipped config names its providers `premium` and `fast` — by the role they
  play rather than by who sells them, so swapping the vendor behind one is a
  base URL. What stays vendor-named is the adapter file, because an anonymous
  adapter for a named API would be unreadable; the core, the ports and the
  composition root say nothing. `providers` is **required**, which broke five
  test fixtures — the honest price, since the only way to infer it would be to
  hardcode the vendor names this removes.
- **The console edits configuration files, and validates them with the
  harness's own parsers (console phases 4 and 5).** Configuration stays in
  `config/*.json` under Git: a table would cost the history, the review of a
  price change, the fork model and a reproducible deploy, and would buy a form.
  So the console is an editor and a validator that never becomes the only way
  in. It checks a draft with **`parseModelConfig` and `parsePersona` themselves**
  rather than a second schema, which would agree today and drift by Christmas —
  nothing that would stop the harness starting reaches the disk. (Writing an
  invalid fixture is how the test suite came to demonstrate that a `sensitive`
  route may not use a cheap model.) `connectors.json` is checked as a *shape*
  instead, because the harness's loader resolves `${VAR}` against the
  environment and a secret unset on this machine is not a reason to refuse
  somebody's edit; placeholders are written back untouched, since resolving one
  to display it puts a client secret on a web page and resolving one to save it
  writes the secret into Git. Only three files are editable **by name**: a path
  from a form is input, and without the allow-list `../../.env` is readable and
  the console is a secret viewer. Compose mounts `config/` read-write, because
  an editor whose changes vanish on the next rebuild discards your work. The
  browser gets only a JSON check and a diff, from a module with no harness
  import — a client component importing `config-files.ts` dragged `pg`, and
  therefore `net` and `dns`, toward the browser, which is how that boundary got
  drawn and why the two files live apart. The evals page shows **confidence
  beside each failure**: wrong-and-sure is a module description that misleads
  the router, wrong-and-unsure is a genuinely ambiguous case, and the fix is in
  different places.
- **Conversations are listable, and a turn routes and runs under one trace
  (console phase 3).** `SessionStore.list` is the fourth port a console page has
  asked for. `find` answers about a session whose id you already hold, which is
  only true of the one you just created — anything that lets a person come back
  starts from "which conversations are there". Ordered by **last activity**, not
  creation: one replied to this morning matters more than one opened last week
  and abandoned, and an empty conversation reports its creation rather than a
  null that would sort at an arbitrary end. The Postgres adapter gets the count
  and the timestamp from one join, because a list of thirty must not be
  thirty-one round trips. The playground takes a turn as `route` then `run`
  **sharing the trace id** the decision returns, so the panel beside the chat
  shows *why* a module was chosen and not only what happened after. The product
  also fills the module registries and the agent's `ToolRegistry` with the same
  tool objects — the harness keeps them apart because a product may want the
  agent to run less than a module advertises, and this one wants them identical
  so a page cannot show one thing while the agent runs another.
- **A model provider is built on first use, not when the harness is (found by
  `docker compose up`).** Providers read their key in their constructor and were
  built while the harness was, so a key was required to do things that never
  touch a model: create a tenant, read a trace, show a cost table. A console
  rendering last month's spend had to be handed an API key, and a one-command
  start died on a provider nobody had asked for. `LazyProvider` moves
  construction to the first `invoke`. **The wiring check does not move** — a
  lazy provider knows its `name` immediately, so a route pointing at a provider
  nobody registered still fails while the gateway is built, which was the
  mistake worth catching early. Only the *credential* requirement moves, to
  where it is genuinely needed, with the same message it always had. The
  companion decision: `ensure-tenant.mjs` uses `PostgresTenantStore` directly
  rather than `createHarness`, because creating a tenant is a row in a table and
  booting the whole composition to write it drags persona and model
  configuration in as prerequisites for a schema operation.
- **`docker compose up` starts everything, and the tenant is a service rather
  than a side effect.** `postgres` → `migrate` → `seed` → `console`, the middle
  two running once and exiting. The console still refuses to create its own
  tenant, which is right for a page load and wrong for a first start — so the
  creation is a step somebody can read in the compose file, disable, or run by
  hand, instead of a side effect hidden in a page. The console binds `0.0.0.0`
  *inside* its container and is published to `127.0.0.1` on the host: a server
  bound to loopback inside its own namespace is unreachable from anywhere, and
  the loopback rule belongs at the published port. Its Dockerfile copies sources
  **before** `npm ci`, the opposite of the harness image, because npm runs
  `prepare` for a `file:` dependency while linking it and `--ignore-scripts`
  does not reach that. And `configDir` is named rather than inferred from
  `process.cwd()`: Next's standalone server runs from its own directory, which
  is exactly how this failed the first time it ran in a container.
- **The approval inbox is per tenant, and a rejection carries a reason (console
  phase 2).** `ApprovalStore.list` answers about one conversation, which is only
  useful to somebody who already knows which conversation to look at — and a
  person deciding does not. `pending(tenantId)` is the third port a console page
  has asked for, oldest first, because each row is a turn parked mid-flight with
  somebody waiting on the other end. **Adding a required method to a port is
  breaking after 1.0.0**, and this one immediately broke a test double, which is
  the demonstration: doing it before the tag is the cheap moment. The review
  screen shows the tool, **the exact input**, and the turn that led here — a
  queue showing only a tool name asks people to approve a verb, and a reviewer
  who cannot see the input is a rubber stamp with extra steps. The input is
  rendered as stored, not re-scrubbed: it was redacted on the way in, and
  redacting again would hide the difference between "the secret was caught" and
  "the display is hiding it", on the one screen where a person vouches for
  exactly these bytes. A rejection should carry a reason and an approval need
  not — "no" is the answer somebody has to act on, and an MCP rejection with
  none gets retried forever. `decided_by` records that the decision came through
  the console rather than inventing a name, because an audit trail's value is
  being true; `CONSOLE_OPERATOR` is how a deployment says something real.
- **Finishing an OAuth flow is a port, and the client secret never leaves it
  (console phase 1).** The harness had both ends — `OAuthClient` for the
  mechanics, `ConnectionStore` and `CredentialVault` for the storage — and
  nothing joining them. The absence only showed up when something had to
  actually run a flow, which is the console's Connections page. So
  `ConnectionOnboarding`: authorization URL in, stored connection with a sealed
  credential out. Callers name a **connector**, never receive an
  `OAuthProvider`, because handing one out would put a client secret in every
  surface that renders a "connect" button. **A connection with no credential
  must not exist**: if sealing fails after the row is written, the row is
  removed — one that looks connected and cannot authenticate fails later, at a
  call, and reads as the source being down. Scopes recorded are the ones the
  provider **granted**, not the ones requested, since a person can decline part
  of a consent screen. On the console side, `state` is 32 random bytes in an
  HttpOnly cookie compared against the URL, with **no signing key**: the cookie
  is unreadable and unwritable from script, so comparing a value the attacker
  cannot see is the whole defence and a key would protect nothing more. It is
  checked **before the code is spent** — trading first would attach the account
  and then discover the callback was forged. Disconnecting erases the credential
  but does not revoke at the provider, which only the source can do; claiming
  otherwise would leave a live token behind a console saying it is gone.
- **An MCP write is gated by refusing, and the approval is for those arguments
  (MCP.4).** The agent loop's gate pauses a turn; MCP has no turn, so it cannot
  be reused — a request that has not been answered is one timing out on a
  socket. A gated call therefore creates a `pending` approval, **does not run**,
  and tells the client to call again once somebody has decided. Refusing is the
  mechanism rather than a failure mode: retrying is ordinary MCP behaviour. The
  request's identity is a **hash of the tool name and its canonical arguments**
  — necessary, because the protocol hands out no id that survives a retry, and
  load-bearing, because keying on the tool alone would let a client get approval
  for something harmless and then send something else. Keys are sorted before
  hashing so a reordered payload does not ask a person twice; array order is
  kept, since there order is meaning. **Enabling a write is now a decision that
  has to be written down**: `allow` with a write and no `approvals` throws at
  construction unless the product passes `ungated: true` — at construction, not
  at the first write, because a check that fires the day somebody deletes
  something is not a check. Two things deliberately not done: **an approval is
  not consumed** (`approved` is terminal, so the identical call can be replayed;
  single use needs a column and a migration, and the exposure is bounded by
  being identical), and **`approvals.session_id` stays `NOT NULL`** — the
  product supplies a long-lived anchor session per tenant, because making the
  column nullable would break the transitive tenant anchoring `npm run
  isolation` enforces, trading a schema guarantee for a convenience.
- **Spend reads back grouped, and the page that asked shaped the port (F6.6).**
  `spend()` stays — "what has this tenant cost" has one honest answer — and
  `breakdown()` answers "where did it go", by model, task, day or session,
  dearest first. This is the method doc 21 argued for rather than an exception
  to it: the Cost page shipped stating what it could not show, and the port
  followed. Two calls inside it. **The dimension is a lookup, never
  interpolation** — it becomes SQL through a fixed table of expressions, because
  this is the query an operator surface drives from a URL. **A null key is
  excluded, not bucketed**: a call made outside a conversation belongs to no
  session, and gathering those under "none" would put the biggest, unclickable
  row at the top of the page (they remain in the total). `savings()` returns
  **null** when compression never ran, which is a different answer from having
  saved nothing, and reports both token counts rather than a ratio — a ratio
  hides how much of the traffic compression even touched.
- **The console lives in this repository, and the Golden Rule stops at `src/`
  (F7.1, phase 0).** It is one product: a harness nobody can see is a library
  with a promise, and the console with no harness is an empty page. One repo
  means one version, one CI, one governance setup and no drift to manage — the
  alternative was a second repo to pin by tag, which is a problem invented to
  solve a problem nobody had. The console is a **product** built on the harness,
  so it may know things `src/` must not; the boundary check still reads `src/`
  only, and ESLint ignores `console/` because it has its own toolchain (JSX, DOM
  lib, bundler resolution). It imports **`yas-harness` by package name**, not a
  relative path into `../src` — so a broken exports map fails the console build
  rather than surprising the first person who installs the package. The
  Dockerfile pins `npm ci --workspaces=false`, or the harness image would carry
  React. **Its real job is as a boundary test**: every place it needs raw SQL
  instead of a port is a gap, and phase 0 found one immediately —
  `ToolRegistry.list()`, because there was no way to see which tools are gated
  without holding the definitions, and holding those means holding `execute`.
  Kept separate from `schemas()`, since a model must **not** be told which tools
  are gated: that is a fact about the humans behind the tool, and telling it
  invites reasoning about the gate instead of about the task. The Cost page
  states what it cannot show rather than rendering its one aggregate as the
  whole story — leaving F6.6 to be shaped by a page that asked, not by a guess.
- **Bringing a model key is opting out of the platform's (E3).** BYOM is a
  routing decision before it is a credential one. A tenant with no keys is
  routed exactly as before, on ours; a tenant with *any* key is routed only to
  providers they have a key for, and a task whose candidates are all uncovered
  **fails** rather than falling back. Falling back is the tempting alternative
  and the one worth engineering against: it sends that tenant's data to a
  provider they deliberately did not choose, bills us for it, and from the
  outside looks exactly like success — they get the answer they expected and
  find out months later. The same reasoning makes an unreachable key store an
  error rather than an assumption of "they have none". `ModelKeys` is split so
  that `providers()` decides routing without unsealing anything and `resolve()`
  unseals for the one provider about to be called — a request landing on the
  first candidate never decrypts the key for the second. Keys share the tenant's
  existing data key rather than getting their own, so one tenant has one DEK and
  revoking it covers everything they own; a tenant whose *first* secret is a
  model key gets that DEK created, because requiring them to connect a source
  first would be an ordering nobody could guess. `model_usage.billed_to` exists
  because a tenant on their own key must not be invoiced for spend that was
  never ours, while the cost stays recorded — what a call cost is worth knowing
  either way. **Registered against the plan honestly:** E3 sat in the parking
  lot pending "a paying product asking for it", and was built ahead of that on
  request; the surface is deliberately narrow (a port, a vault, one gateway
  policy) so it costs little to carry until then.
- **A third-party MCP server is a connector, and its session belongs to one
  tenant (MCP.3).** The mirror of MCP.2: that direction exposes our connectors
  as MCP tools, this one consumes somebody else's server as a source, both over
  the same `Resource` vocabulary. It declares **`list` and `read` only** —
  MCP's resource primitive has no search and no writes, and a connector that
  claims a capability it cannot honour fails at the first live call, which is
  what the registry's check exists to prevent. **MCP is stateful, so a session
  is credential-scoped**: `initialize` opens it with one tenant's token, and a
  Streamable HTTP server hands back an id carrying that authorisation. The cache
  is therefore keyed by tenant *and* connection, never by server — keying by
  server would hand tenant B a handle opened as tenant A, the exact leak the
  schema spends a composite key preventing elsewhere. Nothing caches the
  credential itself, so a refreshed token is in use on the next call and the
  vault stays the source of truth. **stdio is not shipped**: it means spawning a
  child process, and a multi-tenant service spawning one per tenant has turned a
  connection into an execution surface — a product that wants it writes twelve
  lines against `McpTransport` and owns that. A server's answers are treated as
  what they are, somebody else's text heading for a model's context: page sizes
  and content lengths capped, shapes validated, anything unrecognised dropped
  rather than forwarded.
- **Liveness checks nothing, and readiness is false before anything closes
  (F6.4/F6.5).** Two questions kept apart. Having `/healthz` ping the database
  is the most damaging mistake available here: a blip fails liveness on every
  replica at once, the orchestrator kills all of them, and since restarting a
  pod does not fix a database, a recoverable outage becomes a crash loop — the
  platform amplifying the fault instead of absorbing it. So liveness asks only
  whether the process is wedged, and dependencies live in readiness, where
  failing means being pulled from the load balancer and left running to recover
  on its own. Readiness is also false the moment draining begins, **before** the
  pool closes: that ordering is what makes a shutdown graceful, because closing
  first fails every in-flight turn with a connection error that reads in the
  logs as a database problem rather than as a deploy. A session already survived
  a restart by living in Postgres; what a restart lost was the turn in flight,
  which is what `Lifecycle.run` now holds a deploy open for. **No endpoints and
  no signal handler by default** — a product owns its transport, and a library
  that hooks `SIGTERM` on import has taken over a process it does not own.
- **Traces export as OpenTelemetry spans, hand-written and live (F6.3).** The
  `traces` table was already span-shaped by design, so the exporter is a
  translation: `toSpan` is a pure function of a step, and `OtlpTraceRecorder` a
  decorator that batches the result to an OTLP/HTTP collector. **No
  OpenTelemetry SDK.** The harness is a library, so its dependency tree lands in
  every product whether or not that product exports anything — and what the SDK
  would buy is auto-instrumentation of things the harness does not do. Three
  calls worth knowing. **Spans are exported as steps are recorded, not read back
  from the table**: that is how OTel works, it needs no schema change and no
  database, and the cost is stated rather than hidden — wiring it on Tuesday
  does not send Monday. **Ids are derived, never random** — a span id is
  `sha256(traceId:sequence)` — so re-exporting a step updates a span instead of
  duplicating it, and a child names its parent with no state held between calls;
  since step 0 is the turn beginning, it is the root and its id follows from the
  trace id alone. **A full queue drops the oldest and says so**: telemetry must
  not be what kills the process it observes, and the newest spans are the ones
  describing what is happening now. The exporter sits **inside** the redactor,
  so what leaves for a third party is scrubbed by the same pass as what is
  stored, and `OTEL_EXPORTER_OTLP_ENDPOINT` wires it — the variable the rest of
  an instrumented fleet already reads, making it a deployment concern rather
  than a code change.
- **The read surface exists, and a real consumer chose its shape (F7.2b).**
  The harness had rich write ports and almost no way to read: no tenant surface
  at all (a product's first action was raw SQL), no way to read a trace or a
  spend back, and no handle on the pool people were opening a second one for.
  Adding `TenantStore`, `TraceReader` and `UsageReader` closed the first three;
  the terminal example that had punched those holes now imports no database
  driver at all, which is the proof rather than the claim.
  **The readers are separate interfaces from the recorders** — the agent only
  ever writes and an operator surface only ever reads, so neither should have to
  implement the other half; the shipped adapters implement both. `TraceReader`
  carries `recent()` as well as `trace()`, because a reader that can only answer
  about a turn whose id you already hold is only useful to the caller who just
  ran it. Reading is **not** redacted: what was written was already scrubbed on
  the way in. `TenantStore.delete` is the erasure mechanism — every user-data
  table cascades from `tenants`, so a deletion request is one call, which is
  what makes it a right the harness can honour rather than describe.
- **`createHarness` accepts a gateway, so the composition can be tested (F7.1).**
  The providers are constructed eagerly and each one needs its own key, so
  building a harness without a provider key was impossible — which meant the one
  function every product calls first had never run, in any test, and a product
  could never test its own wiring either. `HarnessOptions.gateway` replaces the
  routed gateway outright, providers included. The consequence is deliberate and
  worth knowing: the usage recorder lives *inside* `RoutedGateway`, so a
  supplied gateway takes over its own cost accounting.
- **Every external call in the connections layer has a deadline, and the caller
  sets it (F7.0).** Ten connectors were calling `fetch` with no `AbortSignal`: a
  source that accepts the connection and then goes quiet would hold a user's
  turn open indefinitely, and nothing above could stop it. `ConnectorContext`
  now carries a `signal` and every connector passes it down. The **duration is
  policy and belongs to the caller** — `ConnectionManager` sets it (30s default,
  configurable), not each connector, so a slow source cannot decide for itself
  how long it may be slow. The clock starts **after** the credential resolves: a
  slow token refresh is a different failure from a slow source, and charging one
  against the other's budget reports the wrong one. An abort is translated to a
  typed `ConnectorTimeoutError` naming the connector, the capability and the
  budget, because the response to it differs from every other connector failure
  — a 404 means ask for something else, a 401 means re-authorise, a timeout
  means try again later — and a caller that cannot tell them apart retries the
  wrong ones. The token endpoint gets its own, shorter budget (15s): it is a
  small request that sits in front of the real work. Enforcement is a test that
  **reads the connector sources** and fails when a `fetch` has no `signal` —
  behavioural coverage would mean ten brittle fixtures for one property, while
  what actually regresses is an eleventh connector forgetting it.
- **Crossing the module boundary is asking, and the owner answers (F6.1).**
  A module's pool is private, so a module that needs what another holds sends a
  `ContextRequest` and the **owner** decides. The inversion is the point: if the
  requester could read, every module would have to trust every other module
  forever and the decision would sit far from the data; because the owner
  answers, it decides per request — with the purpose in front of it — and can
  reveal a summary instead of the rows, or refuse with a reason the requester
  can pass to the user. Sharing is opt-in on the `ModuleDefinition` (`disclose`)
  and **fails closed**: a module that declares none shares nothing, because
  silence is not consent. A purpose is required — it is what the owner judges,
  and the safe answer to an undecidable request is no. `ContextBroker` is
  deliberately thin: it does not decide, cache, merge or widen, since each would
  move a judgement somewhere the owner cannot see. A wiring mistake (unknown
  module, empty purpose, a module asking itself) **throws** rather than being
  reported as a denial, so a caller cannot mistake a bug for a policy. Every
  exchange is recorded as a `context_request` trace step — the only point where
  data crosses a module boundary, so the one most worth auditing — carrying who
  asked, for what, and which keys came back, but **not the values**: those are
  the owner's data and stay in its pool. What the harness cannot do is
  authenticate the requester; it discloses to whoever the caller names.
- **A trace is a flat list of steps, and it dies with its conversation (F6.2).**
  `model_usage` answers "what did this cost"; the `traces` table answers "what
  happened" — input, routing decision, each model call, each tool, the ending.
  They are separate tables because their **lifetimes are opposite**: a usage row
  survives a deleted conversation (the money was spent) while a trace must not,
  because it carries the user's own words — so `traces` cascades on the session
  and `model_usage` only nulls `session_id`. The shape is a flat, ordered list
  sharing a `traceId`, not a tree: enough to reconstruct a turn, appendable as
  it happens (a turn that dies half way still shows how far it got), and already
  span-shaped for the OpenTelemetry exporter that is a later slice. Order is an
  explicit `sequence`, not `created_at` — `now()` is the transaction timestamp,
  so steps written together would sort arbitrarily — and `(tenant, trace,
  sequence)` is unique, making a duplicated position a failed write rather than
  a trace that silently misreads. The user's message is **not** copied into the
  step: it is already on the session, and repeating it would double the exposure
  for no information a reader lacks. `detail` and `errorMessage` are redacted;
  `label` is not, being a name the harness chose. A caller may pass one
  `traceId` to both `Router.route` and `Agent.run` so the decision and the turn
  it chose read as one trace. Off unless a recorder is wired, and a recorder
  that throws never reaches the turn.
- **Compression is wired into the gateway, but a product turns it on (E5.5).**
  `RoutedGateway` takes an optional `ContextCompressor` and, when given one,
  compresses **once before the fallback chain** — every candidate then gets the
  same context, and a retry does not re-run a deterministic pipeline or muddle
  what it cost. The saving lands in `model_usage` as
  `compression_before_tokens` / `compression_after_tokens`, kept apart from
  `input_tokens`: those are the provider's exact numbers, these are the
  harness's `TokenCounter` over rendered text. **Null means no compressor was
  wired**, which is a different fact from "ran and saved nothing" (an equal
  pair), so the pair is nullable together and constrained to be all-or-nothing.
  There is deliberately **no `after <= before` constraint** — an engine applies
  on a *character* reduction, and a tokenizer can turn fewer characters into
  more tokens; that belongs in the data, not in a write that fails at 3am. A
  compressor that throws is caught: the request goes out uncompressed, matching
  the pipeline's own floor of "no change" — losing a saving is a cost problem,
  losing the user's turn would be worse. Default is no compressor.
- **The release gate is a with/without eval, not a size threshold (E5.5).**
  The sensitivity gate proves a value was not corrupted; it cannot prove the
  model still *used* it. So `src/compression/eval.ts` asks each case twice —
  uncompressed and compressed — and counts the one outcome that should block a
  release: a case the baseline got right and the compressed run got wrong. A
  case **both** runs fail is `inconclusive`, not a regression: that is a broken
  case or prompt, and charging it to compression would let a bad case set veto a
  good engine. A compressed call that throws *is* a regression — a request the
  provider rejects is a way compression breaks an answer. Cases assert exact
  values a correct answer must carry (an id, a total, a date), never phrasing,
  because models vary between runs and an assertion on wording would report that
  variance as a regression. Mirrors the router's eval: mechanism here, data in
  the product.
- **The cacheable prefix is never compressed — not even losslessly (E5.7).**
  A request may declare a `CachePrefix` (`system`, `tools`, and the first N
  messages), which does two things: the Anthropic adapter puts a single cache
  breakpoint at the end of that region, and the compression pipeline splits it
  off and splices it back byte-for-byte. Downgrading the prefix to lossless
  engines — the other option considered — does not work: *lossless* means
  meaning-preserving, while a cache match needs **byte-identical**, so even a
  whitespace trim loses it. The economics settle the rest. A cached read bills a
  fraction of the input rate and re-writing the entry bills above it, so
  shrinking an already-discounted prefix wins a few percent of a small number
  while a churned prefix costs an order of magnitude more; compression could
  also push a prefix under the provider's minimum cacheable size, which fails
  **silently** as "no cache" rather than as an error. Splitting the region out
  (rather than restoring it after the fact) is also what keeps the report
  honest: an engine can no longer be credited for shrinking bytes that get put
  back. Only the declared prefix is marked, never the tail — the tail changes
  every turn, so marking it would pay the write premium for an entry nothing
  reads. The declaration is the caller's: only it knows what is stable, and the
  hint is clamped to the messages actually present. Providers without prompt
  caching (Groq today) ignore it and lose nothing.
- **Secret redaction is always-on, on the persistence and log path (E5.6b).**
  A `SecretRedactor` port with a shape-based default (`RegexSecretRedactor`:
  PEM blocks, JWTs, AWS/Google/GitHub/Slack/Stripe/OpenAI-style keys, Bearer
  tokens, URL credentials, labelled `password=`) scrubs credentials out of free
  text before it lands anywhere durable. It is the **inverse** of compression and
  the gate — it destroys a value on purpose — so it is wired as an unconditional
  decorator, never a discardable engine: over the session store (message
  content), pool store (values), approval store (held tool input) and usage
  recorder (`error_message`), plus the gateway's one log site. A `redactDeep`
  helper walks arbitrary JSON payloads redacting string leaves. Patterns are
  linear (no ReDoS); rules are shape-based so prices, dates and ids survive. In
  `src/redaction/`; the redactor is instantiated once at the composition root.

## Connections and credentials

- **The first real connector is Confluence Cloud, and it validated the
  contract.** Pages map to resources, storage-format body to content, cursor
  pagination to `nextCursor`, and Confluence's read-then-write version rule is
  hidden inside `update`. No product domain leaked in — a page is a document.
- **GitHub is the third connector; it addresses a repo as the `parentId` and a
  resource id is `owner/repo#number`.** GitHub has no site id (unlike Atlassian)
  and issue bodies are Markdown (simpler than Jira's document tree). It declares
  no `delete` capability, since GitHub does not delete issues over the API — a
  connector legitimately exposing only what its source supports. Pull requests
  that GitHub returns through the issues endpoint are dropped. Issues came first;
  discussions, projects and code followed.
- **The GitHub connector is multi-type, routed by an id discriminator.** One
  connection reaches issues and code (REST) and discussions and Projects v2
  (GraphQL), so it is one connector with several resource kinds rather than four
  connectors. The id names the kind: `owner/repo#number` (issue),
  `discussion:owner/repo#number`, `project:owner/number`, `code:owner/repo:path`
  (a file or directory). Issues, discussions and code hang off a repository; a
  project hangs off an owner (a user _or_ an org), so its container is the owner
  login, not a repo. A tiny GraphQL client (`github-graphql.ts`) is the shared
  GraphQL transport, mapping a `NOT_FOUND` error to a missing resource like a
  REST 404.
- **Projects resolve user-vs-org in a single query via `ProjectV2Owner`.** A
  project's owner may be a user or an organization, and GitHub has no unified
  login-to-projects field on either. Rather than probe both or ask the caller
  which it is, the queries go through `repositoryOwner(login:)` and spread
  `... on ProjectV2Owner` — both `User` and `Organization` implement it — so one
  query reaches the project without the connector knowing the owner's kind. The
  project readme maps to `content`; its short description rides in metadata.
  `createProjectV2` takes only a title, so a body given at create is applied as
  a follow-up readme update, keeping create's `content` first-class.
- **Code reading is read-only, over the REST contents API.** `list` browses a
  directory and `read` fetches a file, mapping a directory to a `dir` resource
  and a file to a `file` whose base64 body is decoded to text on read (and left
  null in a listing, as the contract asks). A code id is `code:owner/repo:path`;
  a bare `owner/repo` or a `code:` directory id is the browse container, and a
  file parents to its directory. Writing code means commits and pull requests,
  which are out of this slice, so no create/update/delete for code. Code search
  is deferred too: `SearchOptions` has no type selector yet to tell a code
  search from the issue search the connector already does.
- **Confluence and Jira are the first two connectors, over shared Atlassian
  plumbing.** Both use the same OAuth 3LO auth, `cloudId` discovery and
  `ex/{product}/{cloudId}` base, so that lives in one `AtlassianSite` helper and
  each connector writes only its endpoints and translation. Jira maps issues to
  resources and flattens the Atlassian document format to and from text.
- **Google Drive is the fourth source, and a file's body is best-effort text.**
  A file maps to a resource and a folder to one you browse into (`parentId` is
  the folder). The body is a best-effort text rendering: a Google editor file is
  exported (a Doc to `text/plain`, a Sheet to `text/csv`), a text file is
  downloaded via `alt=media`, and a binary (an image, a PDF) has no text body so
  its content stays null. The resource keeps the file's own Drive mime type even
  when its content is the export, so a consumer can tell a Doc from a plain file.
- **Drive writes go metadata-first, then a media upload, avoiding multipart.**
  `create` posts the file's metadata, then — if a body was given — uploads it to
  the same id through `uploadType=media` (a raw body, no multipart envelope),
  the same follow-up shape as the GitHub project readme. `update` patches the
  title as metadata and the body as a media upload, each only when present.
  `delete` is Drive's permanent delete (it skips the trash), matching the
  contract's delete; the destructive-action gate lives a layer above.
- **Slack is the fifth source, multi-type like GitHub: channels and messages.**
  One connection reaches both, routed by an id discriminator — `channel:C123`
  and `message:C123:<ts>` (the Slack timestamp). A channel is a container you
  browse into, so a message's `parentId` is its channel's resource id and
  listing a channel's history takes that (or the bare channel id) as the parent.
  Channels are read-only (list, read); messages are full — history, read-one
  (there is no "get message", so history is asked for the single `ts` and the
  `ts` is verified), search via `search.messages`, and post/edit/delete. A write
  against a channel id is refused with a clear error. Slack returns HTTP 200 with
  `{ ok: false, error }`, so `channel_not_found`/`message_not_found` map to
  not-found and any other error to a connector error.
- **Notion is the sixth source, multi-type (pages and databases) with a text
  body — the same trade Jira makes.** Ids are `page:<uuid>` and
  `database:<uuid>`. Notion is block-based, so a page's `content` is a text view:
  read flattens the top-level blocks (headings, lists, quotes rendered with light
  Markdown), and write turns text back into paragraph blocks — rich blocks
  flatten on read and are not preserved on write, and setting content replaces
  the page's blocks (deep nesting is not recursed). A page has no top-level
  title; it lives in the title-typed property, so the title is read from
  whichever property is of type `title`, and creating a page in a database
  resolves that database's title-property name rather than assuming "Name". A
  database is a container: listing it queries its pages, and listing with no
  parent falls back to search (which returns both kinds). Delete archives, since
  Notion has no hard delete over the API.
- **Google Calendar is the seventh source, multi-type: calendars and events.**
  Ids are `calendar:<id>` (the id may be `primary` or an address) and
  `event:<calendarId>:<eventId>` — an event lives in a calendar, so its
  `parentId` is the calendar's resource id and listing a calendar's events takes
  that (or the bare id) as the parent. Calendars are read-only (list, read);
  events are full CRUD. An event's times are its own fields, so `start`/`end`
  and `location` ride in `metadata` (and `content` is the description); a value
  with a `T` is a timed `dateTime`, otherwise an all-day `date`. Create needs a
  calendar and both times. Search is per-calendar, defaulting to `primary`, and
  a write against a calendar id is refused.
- **Cal.com is the eighth source: event types and bookings, no search.** Ids are
  `event-type:<id>` (a bookable template, read-only) and `booking:<uid>` (a
  scheduled meeting, full CRUD); a booking's `parentId` is its event type. The
  writes map to Cal.com's verbs, not generic ones: create is _book a slot_
  (needs the event type, a start and an attendee), update is _reschedule_ (a new
  `metadata.start`), delete is _cancel_. Cal.com has no free-text booking search,
  so the connector does not declare `search` — it exposes only what the source
  supports. Responses are unwrapped from the `{ status, data }` envelope, and
  each endpoint group is pinned to its dated `cal-api-version`. The credential is
  a bearer token — an API key or OAuth access token — so no OAuth provider entry
  is needed for the key case.
- **Calendly is the ninth source: read and cancel, no create or reschedule.**
  Ids are `event-type:<uuid>` (a bookable template) and `event:<uuid>` (a
  scheduled event), the uuid taken from Calendly's resource URI; a scheduled
  event's `parentId` is its event type. Calendly's API does not create scheduled
  events (an invitee books through a link) or reschedule them, so the connector
  declares only `list`, `read` and `delete` (which cancels a scheduled event) —
  the honest surface. Both list endpoints are scoped to a user, so the connector
  resolves the account's URI from `/users/me` rather than making the caller pass
  it, and it unwraps Calendly's `{ collection, pagination }` and `{ resource }`
  envelopes.
- **Microsoft Teams is the tenth source, three levels deep: teams, channels,
  messages.** Over Microsoft Graph, one connection reaches the whole hierarchy,
  routed by an id discriminator — `team:<id>`, `channel:<teamId>:<channelId>`,
  `message:<teamId>:<channelId>:<messageId>` — because a channel and a message
  need their full path. Graph channel ids themselves contain colons and an `@`
  (`19:abc@thread.tacv2`), so the id stays unambiguous by taking the team as the
  first segment and the message as the last (both colon-free) with the channel
  id in between. `list` browses down the hierarchy (no parent → teams; a team →
  its channels; a channel → its messages). Teams and channels are read-only;
  messages can be posted, but Graph v1.0 has no edit or delete for a channel
  message, so the connector declares only `list`/`read`/`create` — the honest
  surface. The real friction is not code but Azure AD app registration and
  admin-consented permissions (`ChannelMessage.Read.All`, `ChannelMessage.Send`).
- **Connectors are exposed over MCP as six generic tools, read-only by default.**
  Because every connector speaks one `Resource` shape, `list`/`read`/`search`/
  `create`/`update`/`delete` (each taking a `connectionId`) cover them all — no
  per-connector tools. The server is mechanics (`handle` maps one JSON-RPC
  message to one response; the product runs the transport and resolves the
  tenant), hand-written with no dependency, tenant-scoped, and writes are off
  unless a product opts in via `allow`. See
  [ADR 0009](./adr/0009-mcp-connectors.md).
- **The `cloudId` is discovered at runtime, not stored in the credential.**
  The refresher rewrites a plain `OAuthToken` on refresh, which would drop any
  extra field, so the site id is fetched from `accessible-resources` and cached
  per connection for the process lifetime instead of stored alongside the token.
- **OAuth is mechanics, not web endpoints.** The harness builds the
  authorization URL, exchanges the code and refreshes the token; minting
  `state`, redirecting the user and receiving the callback are the product's
  job — the same boundary as approval. See
  [ADR 0007](./adr/0007-oauth-and-transparent-refresh.md).
- **Token refresh is transparent, inside an active connection.** A stale access
  token is refreshed on next use (with a skew, to avoid racing expiry) and
  stored back; the connector and agent only ever see a working token. A
  connection becomes `expired` only when a refresh actually fails and
  re-authorisation is needed — then the next call fails fast.
- **OAuth providers are declared in `config/connectors.json`, secret from env.**
  Endpoints, client id and scopes live in the file, keyed by connector id; the
  client secret is named there by its environment variable and resolved at load
  time, so no secret is committed. A missing named secret fails at startup.
- **The manager takes a `CredentialResolver`, not the vault directly.** The
  default reads the vault as-is (right for a static API key); the OAuth resolver
  adds refresh. A non-OAuth connector's credential passes through untouched, so
  both kinds coexist without a special case in the run path.
- **Every source fits one resource-shaped contract** (list, read, search,
  create, update, delete over a `Resource`). Adding Drive, Confluence or Notion
  is registering a connector; the manager, vault and schema do not change.
  Source-specific fields live in a `metadata` bag so translation loses nothing.
  See [ADR 0006](./adr/0006-connector-contract.md).
- **Editing is first-class, not read-only-first.** create/update/delete are in
  the contract from the start; the dogfooding case and the products both need
  to write back, and retrofitting write is worse than designing for it once.
- **Connected data is cached as `Resource` snapshots, read-through and
  stale-tolerant.** The cache keys on `(tenant_id, connection_id, resource_id)`
  and cascades with its connection, like credentials. `CachedConnections` serves
  a snapshot while fresh, fetches and caches on a miss, and — when the source is
  down — serves the last snapshot rather than an error; writes are write-through.
  Keeping it warm is a mechanic, not a scheduler: `refresh` (polling, prunes what
  vanished, but never against a truncated listing) and `invalidate` (webhook),
  with `getCached`/`listCached` for offline browse. See
  [ADR 0008](./adr/0008-resource-cache.md).
- **Capabilities are declared and gated.** A connector declares what it does;
  the registry checks every declared capability has its method, and the manager
  refuses an undeclared one. A connector may implement more than it declares (a
  full connector in read-only mode), which is allowed on purpose.
- **The connection manager is the credential seam.** It resolves the credential
  from the vault and hands it to the connector for the length of the call; the
  status and capability checks run before anything is decrypted. A connector
  receives a credential and must never log, store or return it.
- **Credentials use envelope encryption with a per-tenant data key.** A master
  key wraps each tenant's data key; the data key encrypts that tenant's
  secrets. One key compromise stays within a tenant, and rotating the master
  key re-wraps the data keys without re-encrypting a credential. See
  [ADR 0005](./adr/0005-connection-layer-and-credential-vault.md).
- **AES-256-GCM over Node's own crypto, no dependency.** Authenticated, so a
  tampered blob fails to open rather than decrypting to garbage; the surface
  used is four calls wide.
- **The connection record and its secret live in different tables.**
  `connections` holds no secret and is freely readable; `credentials` holds the
  sealed bytes. Common reads never touch anything encrypted.
- **The vault is the only code that decrypts, and only the connection layer
  calls it, at call time.** That is what "the agent never sees API keys" means
  concretely; the boundary check keeps `src/core/` from importing the vault.
- **Credential isolation is a composite foreign key.** A credential can only
  attach to a connection of the same tenant — a cross-tenant credential cannot
  be inserted, not merely should not be.
- **The vault is built only when a master key is configured.** A deployment
  that connects nothing does not need one; starting it with a missing key would
  be worse than starting without the vault.

## Approval

- **An approval pause is a return, not a block.** A gated tool makes the agent
  record pending approvals and return `awaiting_approval`; a later `resume`
  continues. No process is held open, and the pause survives a restart because
  its whole state is in the session and the approval queue. See
  [ADR 0004](./adr/0004-human-approval.md).
- **A turn with any gated call is all-or-nothing.** Nothing in the turn runs —
  not even the ungated calls beside it — until every gate is decided, so a
  half-run turn can never be observed.
- **A decision is guarded in the `WHERE` clause.** Moving an approval off
  `pending` only matches a still-pending row, so two operators deciding the
  same approval race on the database and exactly one wins.
- **A rejection reaches the model as a tool result with its reason**, not as a
  failed turn, so the model can change course rather than just stop.
- **A gated tool still fails closed when no approval queue is wired.** The
  approval store is optional; without it, a product does not run sensitive
  actions unchecked by omission.
- **"Who decided" is an opaque string.** The harness does not model operators;
  a product binds real identities to `decidedBy` itself.

## Core and storage

- **Message order is a `seq` identity column, not `created_at`.** `now()` is
  the transaction timestamp, so messages appended together share one value and
  would otherwise sort arbitrarily — a conversation could come back scrambled.
- **The agent passes a snapshot of history to the gateway, not its working
  array.** The loop keeps appending; an adapter must see the conversation as it
  was at call time.
- **A tool declares its input with a Zod schema, and the registry derives the
  JSON Schema the model sees.** One definition, so what is advertised cannot
  drift from what is validated.
- **Invalid input, unknown tools and thrown tools become error results, not
  exceptions.** The model gets to see what went wrong and correct itself, which
  is the point of feeding the result back.
- **Personas are declarative configuration in `config/personas/`**, validated
  with Zod and versioned in Git — so instructions change without touching the
  loop.

## Toolchain and project

- **Native ESM with relative `.js` imports; no path aliases.** Aliases would
  need a bundler or a runtime resolution hack; `tsc` plus Node ESM resolves
  without an extra dependency.
- **Two `tsconfig` files.** The root type-checks `src` and `tests` without
  emitting; `tsconfig.build.json` compiles `src` only.
- **The migration runner is plain ESM (`scripts/migrate.mjs`), not
  TypeScript.** It runs identically from source and from the Docker image, with
  no build step and no dev dependency in production.
- **Every migration must have a reversible `.down.sql`.** The runner refuses a
  migration without one; CI proves the round trip up → down → up.
- **Git hooks run via `core.hooksPath`, not husky** — the same guarantee with
  no dependency, enabled by `npm run prepare`.
- **The local Postgres host port is in the 4000 block, not 5432.** The default
  ports collide with other projects run alongside this one; the container's
  internal port is unchanged.
- **TypeScript is held below 7 in Dependabot.** `typescript-eslint` 8.x caps at
  `typescript <6.1.0`, so a bump to 7 fails `npm ci` on the peer conflict and
  takes the grouped update down with it. Revisit when typescript-eslint
  supports TypeScript 7.
- **The commit-message check skips bot commits.** They are generated, not
  authored; what lands on `main` is the squash title a maintainer writes. Every
  rule still applies in full to every human commit.
