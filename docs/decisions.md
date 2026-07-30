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
