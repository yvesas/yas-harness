# Contributing to yas-harness

Thanks for your interest. This document is short on purpose — read it once and
you will know how to land a change.

## Running it locally

```bash
npm install          # also enables the Git hooks (core.hooksPath = .githooks)
cp .env.example .env
docker compose up -d # PostgreSQL + pgvector
npm run migrate up
npm run check        # lint + typecheck + tests
```

If `npm run check` passes on a clean clone, your environment is fine.

## The golden rule

**The harness knows no product domain.** No "customer", "expense", "meeting" or
"vocabulary" logic here — those belong to modules, which live in the products
that fork this repository.

> Test before you write: would this code work identically in a language tutor
> and in a CRM? If not, it does not belong in the harness.

A change that violates this will be rejected regardless of how well it is
written. It is the one rule the whole project depends on.

## Commit rules

- [Conventional Commits](https://www.conventionalcommits.org/), in English:
  `feat(models): add Groq adapter`
- Allowed types: `feat`, `fix`, `docs`, `chore`, `refactor`, `test`, `perf`,
  `build`, `ci`, `style`
- Subject under 72 characters; explain the *why* in the body
- One logical change per commit, but **group related work** — a coherent commit
  is better than five commits split by file
- **No AI attribution.** No `Co-Authored-By:` trailers, no "Generated with…",
  no tool signatures or bot emoji. This applies to humans and AI agents alike.

The `commit-msg` hook enforces the last two points. Do not bypass it with
`--no-verify`: CI checks the same rules and your pull request will fail.

## Pull requests

Every pull request should state:

1. **Problem** — what is wrong or missing
2. **Impact** — who it affects and how
3. **Evidence** — tests, output, or a reproduction showing it works

Also expected:

- Tests for the change; the core must stay testable without network access
- A linked issue when one exists
- Green CI: lint, typecheck, tests, build
- One maintainer approval; merges are squashed

Changes touching credentials, encryption, permissions or code execution get an
extra review pass. See [CODEOWNERS](./CODEOWNERS).

## Code conventions

- TypeScript in strict mode, native ESM — relative imports carry the `.js`
  extension, and there are no path aliases
- Hexagonal architecture: the core depends on interfaces, never on
  implementations. New providers, stores and connectors are adapters
- Validate every external input with Zod
- Typed errors; never swallow an exception from a connector
- Multi-tenant from day one: any table with user data carries `tenant_id`,
  enforced by a constraint
- Structured JSON logs, and no PII in them
- No secrets in code, logs or tests

## Dependencies

Adding one needs a justification in the pull request: what it does, why writing
it ourselves is worse, and what its license is. The connection and model layers
are deliberately our own — that is a project decision, not an oversight.

## What will not be accepted

- Business logic in the harness (the golden rule)
- A third-party agent framework as a foundation dependency
- Credentials reachable by the agent, or secrets in logs
- A design pattern added because it is elegant rather than because it removes
  real coupling

## Reporting a vulnerability

Do not open a public issue. Follow [SECURITY.md](./SECURITY.md).

## License

By contributing, you agree that your contributions are licensed under the
[Apache License 2.0](./LICENSE).
