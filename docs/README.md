# Documentation

How the harness is built, and why.

## Start here

- **[Architecture](./architecture.md)** — the shape of the system: the golden
  rule, the layers, the ports and their adapters, and the path a message takes.

## Decisions

Two kinds, kept apart on purpose:

- **[Architecture Decision Records](./adr/)** — the load-bearing choices, one
  file each, with the context and the alternatives that were weighed. Read
  these to understand *why* the system is shaped the way it is.
- **[Design decisions](./decisions.md)** — the smaller calls that shaped the
  code but are too narrow for an ADR: a column choice, a dropped dependency, a
  default. One line each, with the reason.

## Index of ADRs

| ADR | Decision |
| --- | --- |
| [0001](./adr/0001-hexagonal-architecture.md) | Ports and adapters for the core |
| [0002](./adr/0002-own-model-gateway.md) | Our own model gateway, not a routing service |
| [0003](./adr/0003-central-router.md) | A central router on the cheap tier, evaluated before trusted |

## Writing a new ADR

Add `docs/adr/NNNN-short-title.md`, numbered in sequence, using the shape the
existing ones follow: **Context → Decision → Consequences → Alternatives
considered**. Record an ADR when a choice is hard to reverse, shapes more than
one part of the system, or is one a future reader would otherwise re-litigate.
For anything smaller, add a row to [decisions.md](./decisions.md) instead.

> Contributor and security docs live at the repository root: `CONTRIBUTING.md`,
> `SECURITY.md`, `CODE_OF_CONDUCT.md`. Agent instructions are in `CLAUDE.md` and
> `AGENTS.md`. This folder is about architecture.
