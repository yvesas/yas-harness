# Copyright 2026 YAS Softwares LTDA
# SPDX-License-Identifier: Apache-2.0
#
# The harness is a library with no HTTP surface, by decision — a product owns
# its own transport (ADRs 0007, 0008, 0009). So this image has two honest uses,
# and neither of them is "run the harness":
#
#   1. A base a product builds on:  FROM ghcr.io/yvesas/yas-harness:1.0.0
#   2. The schema, standalone:      docker run … yas-harness up
#
# Build it from the repository root:
#   docker build -f docker/Dockerfile -t yas-harness .

# --- build stage ------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

# Dependencies first, so a source change does not re-resolve the tree.
#
# --ignore-scripts is load-bearing: `prepare` is `hooks && build`, which npm
# runs on install, and at this point neither tsconfig nor src has been copied.
# Every dependency here is pure JavaScript, so nothing needs a build step of
# its own. The build below is explicit instead.
COPY package.json package-lock.json ./
# --workspaces=false keeps this to the harness itself. The repository is a
# workspace root (the console lives beside it), and without the flag npm would
# install React and Next into an image that serves neither.
RUN npm ci --ignore-scripts --workspaces=false

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- runtime stage ----------------------------------------------------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

# Same reason as above, plus: typescript is a devDependency, so running the
# prepare build here would fail outright.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --workspaces=false && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY scripts/migrate.mjs ./scripts/migrate.mjs
COPY config ./config
COPY LICENSE NOTICE ./

# Provenance, so an image found in a registry can be traced back.
LABEL org.opencontainers.image.title="yas-harness" \
      org.opencontainers.image.description="Reusable agent chassis for YAS Labs products" \
      org.opencontainers.image.source="https://github.com/yvesas/yas-harness" \
      org.opencontainers.image.licenses="Apache-2.0" \
      org.opencontainers.image.vendor="YAS Softwares LTDA"

# Never run as root.
USER node

# The schema is the one thing this image can do on its own, so it is the
# entrypoint: `up`, `down` or `status`, against DATABASE_URL. A product that
# builds on this image overrides both lines.
#
# `status` is the default because it is the only one of the three that changes
# nothing — an image run with no arguments should report, not migrate.
ENTRYPOINT ["node", "scripts/migrate.mjs"]
CMD ["status"]
