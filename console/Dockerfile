# Copyright 2026 YAS Softwares LTDA
# SPDX-License-Identifier: Apache-2.0
#
# The console, as a container.
#
# Unlike the harness image next door, this one *is* meant to be run: it is a
# server with pages. It exists so `docker compose up` gives somebody Postgres
# and a working console in one command, which is the onboarding this project
# promised.
#
# Build it from the repository root — the context is the root, not this folder,
# because the console imports the harness from the workspace beside it:
#   docker build -f console/Dockerfile -t yas-console .

# --- build stage ------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Both manifests: npm needs to see the workspace to link `yas-harness` into the
# console's node_modules. Installing the console alone would leave that
# dependency unresolvable — it is `file:..`, not a registry package.
#
# The harness sources come in *before* the install, which is the opposite of the
# harness image next door and is not an oversight. There, `--ignore-scripts`
# skips `prepare` and the build is an explicit line. Here it cannot be: npm runs
# `prepare` for a `file:` dependency while linking it, and `--ignore-scripts`
# does not reach that. So the sources have to be present for it to succeed —
# and the harness gets compiled to `dist/` as a side effect, which is what the
# console needs anyway, since it imports `yas-harness` by package name.
COPY package.json package-lock.json tsconfig.json tsconfig.build.json ./
COPY console/package.json ./console/package.json
COPY src ./src
RUN npm ci

COPY console ./console
RUN npm run build --workspace console

# --- runtime stage ----------------------------------------------------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production
# Bind every interface *inside the container*. That is not the loopback rule
# being dropped: the compose file publishes the port to 127.0.0.1 on the host,
# so the console is still unreachable from the network. A server that bound
# 127.0.0.1 inside its own namespace would be unreachable from anywhere at all.
ENV HOSTNAME=0.0.0.0
ENV PORT=4100
# Named, not inferred. The standalone server's working directory is its own
# folder, so `process.cwd()/config` would point inside the console.
ENV CONFIG_DIR=/app/config

WORKDIR /app

# Next's `standalone` output carries its own pruned node_modules, so there is no
# second npm install here. `static` and `public` are not traced into it — they
# are served from disk and have to be copied alongside.
COPY --from=build /app/console/.next/standalone ./
COPY --from=build /app/console/.next/static ./console/.next/static
# From the context, not the build stage: neither is copied into it, and there is
# no reason to drag them through a compile to get here. The config is the
# harness's — personas and model routing — and the console reads it through
# `createHarness` like any other product would.
COPY config ./config
# The real one is a deployment's own file and is not in Git, so a build from a
# fresh clone has only the example. Copied rather than renamed: a build context
# that *does* carry one -- somebody building their own image -- keeps it.
RUN cp -n config/models.example.json config/models.json || true
COPY LICENSE NOTICE ./

LABEL org.opencontainers.image.title="yas-console" \
      org.opencontainers.image.description="Operator console for the yas-harness" \
      org.opencontainers.image.source="https://github.com/yvesas/yas-harness" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="YAS Softwares LTDA"

# Never as root. It holds the master key.
USER node

EXPOSE 4100

# The standalone server, at the path the workspace layout puts it.
CMD ["node", "console/server.js"]
