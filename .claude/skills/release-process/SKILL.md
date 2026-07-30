---
name: release-process
description: Use when cutting a release of yas-harness — deciding the version from the commits, curating the changelog, tagging, and publishing the Docker image. Covers what makes a change breaking in a library whose public surface is its ports.
---

# Cutting a release

The order is fixed, and every step before the tag is reversible. The tag is not.

## 1. Decide the version from the commits

```bash
git log --oneline $(git describe --tags --abbrev=0)..main
```

Conventional Commits give the answer, with one twist that matters here:

| In the log | Bump |
| --- | --- |
| `fix:` only | patch |
| any `feat:` | minor |
| `BREAKING CHANGE:` in a body, or `!` after the type | major |

**What counts as breaking in this project.** The public surface is the *ports*,
not just the exported functions. A change is breaking if an existing consumer
must edit code to upgrade:

- removing or renaming a method on a port — anyone who wrote an adapter has to
  implement it
- **adding** a required method to a port — same reason, and this is the one
  people miss
- changing what a method returns, or when it throws
- a migration that is not backward compatible with the previous release's code

Adding an *optional* field, a new export, or a new adapter is a minor.

Before 1.0.0 the ports are unstable and this is advisory. After 1.0.0 it is the
contract.

## 2. Curate the changelog

`CHANGELOG.md` is **not** generated from the log. Read the commits, then write
what changed for someone deciding whether to upgrade:

- Move `[Unreleased]` entries under a new `## [x.y.z] - YYYY-MM-DD`.
- Group as Added / Changed / Deprecated / Removed / Fixed / Security.
- Say what a reader has to *do*, not what the commit did. "`SessionStore` gains
  `list()`; custom adapters must implement it" beats "add list to SessionStore".
- Drop the noise. A refactor nobody can observe does not belong here.

## 3. Prove it is releasable

```bash
npm run check          # lint, format, licences, boundaries, isolation, types, tests
npm run package:check  # packs, installs into a throwaway project, imports by name
```

Both must pass on a clean checkout of `main`, not on your working tree.

## 4. Tag

```bash
npm version 1.2.3 -m 'chore(release): %s'   # bumps package.json, commits, tags
git push --follow-tags
```

The version lives in `package.json` and the tag is `v1.2.3`. Do not hand-edit
one without the other.

## 5. Publish

**Docker image** — the artefact a self-hosting deployment consumes:

```bash
docker build -t ghcr.io/yvesas/yas-harness:1.2.3 -t ghcr.io/yvesas/yas-harness:latest .
docker push ghcr.io/yvesas/yas-harness:1.2.3
docker push ghcr.io/yvesas/yas-harness:latest
```

**npm** — not yet. `private: true` in `package.json` is a deliberate guard;
until it is removed at 1.0.0, consumers install by tag:

```bash
npm install github:yvesas/yas-harness#v1.2.3
```

Removing `private` is the whole switch. Do it in its own commit, not inside a
release, so it is reviewable on its own.

## 6. Write the GitHub release

Paste the changelog section. Add, above it, the one thing the changelog cannot
carry: **what an upgrader has to do**. If that list is empty, say so — "no
action required" is worth reading.

## Before you tag

- [ ] Version matches what the commits imply, breaking changes included
- [ ] `CHANGELOG.md` has a dated section, written for an upgrader
- [ ] `npm run check` and `npm run package:check` pass on a clean `main`
- [ ] Migrations in this release run forward *and* backward
- [ ] No `private` change smuggled into the release commit
