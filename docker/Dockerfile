# Copyright 2026 YAS Softwares LTDA
# SPDX-License-Identifier: Apache-2.0

# --- build stage ------------------------------------------------------------
FROM node:22-alpine AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build

# --- runtime stage ----------------------------------------------------------
FROM node:22-alpine AS runtime

ENV NODE_ENV=production
WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY --from=build /app/dist ./dist
COPY migrations ./migrations
COPY config ./config
COPY LICENSE NOTICE ./

# Never run as root.
USER node

CMD ["node", "dist/index.js"]
