# `docker/` — the published image

## What this image is for

The harness is a library with no HTTP surface, by decision: a product owns its
own transport ([ADR 0007](../docs/adr/0007-oauth-and-transparent-refresh.md),
[0008](../docs/adr/0008-resource-cache.md),
[0009](../docs/adr/0009-mcp-connectors.md)). So there is no server to start,
and this image has two honest uses — neither of them "run the harness".

**1. A base a product builds on.**

```dockerfile
FROM ghcr.io/yvesas/yas-harness:1.0.0
COPY dist ./dist
ENTRYPOINT ["node", "dist/server.js"]
```

**2. The schema, standalone.** The one thing the image can do by itself, which
is why it is the entrypoint:

```bash
docker run --rm -e DATABASE_URL=postgres://… ghcr.io/yvesas/yas-harness:1.0.0 up
```

`up`, `down` or `status`. **`status` is the default**, because an image run with
no arguments should report rather than migrate.

## Building it

From the repository root — the context is the root, not this folder:

```bash
docker build -f docker/Dockerfile -t yas-harness .
```

CI builds it on every change and pushes on none; the release workflow is the
only thing that publishes, and only on a version tag.

## Choices worth knowing

- **`npm ci --ignore-scripts` in both stages.** `prepare` is `hooks && build`,
  which npm runs on install — before `tsconfig` and `src` are copied in the
  build stage, and without TypeScript at all in the runtime stage. Every
  dependency is pure JavaScript, so nothing needs a build step of its own; the
  build is an explicit line instead of a side effect.
- **Two stages.** The runtime carries `dist`, production dependencies, the
  migrations and their runner. No TypeScript, no sources, no tests.
- **`USER node`.** Never root.
- **Multi-architecture (amd64 and arm64).** The stack was chosen so the harness
  runs on a Raspberry Pi as readily as on a server; an amd64-only image quietly
  breaks that promise.
- **A `.dockerignore` at the root**, so `.env` never reaches the build context.
  A secret that is not sent cannot be baked into a layer.

## Local development

`docker-compose.yml` at the repository root runs PostgreSQL with pgvector on
port 4000 — the block avoids colliding with other projects. It does **not** run
this image: for development the harness runs from source.
