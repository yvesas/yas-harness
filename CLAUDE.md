# yas-harness — agent instructions

## What this is

Reusable agent chassis (harness) for YAS Labs products.
Products fork this repo and add business modules on top.

The repository holds **two things, one product**: the harness itself (`src/`,
published as the `yas-harness` package) and the operator console (`console/`, an
npm workspace running Next.js). The console is not a separate project — a
harness nobody can see is a library with a promise, and it is also the boundary
test that reveals which read ports are missing. **The Golden Rule below applies
to `src/` only**; the console is a product built on the harness and is allowed
to know things a harness must not.

## Golden rule

The harness NEVER knows about any specific product domain.
No "customer", "expense", "meeting", "vocabulary" logic here.
Test: if the code wouldn't work identically in a language tutor
and a CRM, it does NOT belong in the harness.

## Stack

TypeScript + Node.js 22 (native ESM) · PostgreSQL + pgvector · Docker
Zod for schema validation · Vitest for tests

## Architecture

Hexagonal (ports & adapters). Core depends on interfaces, never
implementations. SOLID. Clean code. Multi-tenant from day one —
every user-data table carries `tenant_id`, enforced by a constraint.

See `docs/architecture.md` for the full picture, `docs/adr/` for the
load-bearing decisions, and `docs/decisions.md` for the smaller ones. When you
make a design choice worth recording, add a row to `docs/decisions.md`, or an
ADR if it is load-bearing.

Layout, one responsibility per folder (each has a README stating its boundary):

| Folder | Responsibility |
| --- | --- |
| `src/core/` | Agent loop: input → decide → tools → respond |
| `src/router/` | Central router, cheap-model triage |
| `src/modules/` | Module registry and contract (no business modules) |
| `src/models/` | Model gateway and provider adapters |
| `src/connections/` | Own OAuth/connection layer |
| `src/approval/` | Human approval queue |
| `src/memory/` | Session and conversation context |
| `src/pools/` | Per-module data pools and cross-module permissions |
| `src/telemetry/` | Traces and cost accounting |
| `src/lifecycle/` | Graceful shutdown and health answers (no endpoints) |

## Conventions

- Native ESM: relative imports carry the `.js` extension. There are no path aliases.
- `tsconfig.json` type-checks `src` and `tests` without emitting;
  `tsconfig.build.json` compiles `src` only.
- Validate every external input with Zod. Typed errors; never swallow an exception.
- Declarative configuration lives in `config/`, versioned in Git. Secrets never do.
- Structured JSON logs, no PII.
- Run `npm run check` before committing — it mirrors CI: lint, format,
  license headers, boundaries, typecheck, tests.

## Commit and PR rules

- Conventional Commits (feat:, fix:, docs:, chore:, refactor:, test:)
- Commit messages and PR descriptions in English
- NEVER add co-author trailers or AI attribution to commits
  (no "Co-Authored-By", no "Generated with", no tool signatures).
  A `commit-msg` hook rejects them; do not try to bypass it.
- Group related work: prefer few, coherent commits over one commit per file
- PRs must include tests and link the related issue

## Before you code

- Read the relevant SKILL.md in `.claude/skills/`
- Check existing patterns before introducing new ones
- Never add a dependency without justification in the PR

## Security (non-negotiable)

- Credentials are encrypted (envelope encryption); the agent never sees API keys
- Treat all inbound channel messages as untrusted input
- No secrets in code, logs, or tests
- A tool the agent runs can require human approval — mark it `requiresApproval`
  and the turn pauses before running anything, failing closed when no approval
  queue is wired
- Writes exposed over **MCP** are gated differently, because MCP has no turn to
  pause: a gated call is **refused and recorded**, and runs only when the client
  calls again after a person decides. The approval is for *those arguments*, so
  changing the input asks again. Enabling a write in `allow` without wiring
  `approvals` throws unless the product says `ungated: true` — do not reach for
  that flag to make an error go away
