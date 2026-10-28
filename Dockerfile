# syntax=docker/dockerfile:1
# relabeld — white-label engine for self-hosted apps.
# Multi-stage: build TypeScript, install production deps, then ship a slim
# Chromium-capable runtime so `relabeld verify` works inside the image.
FROM node:22-bookworm-slim AS builder
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --include=dev
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

FROM node:22-bookworm-slim AS prod-deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production \
    RELABEL_CHROMIUM_PATH=/usr/bin/chromium
RUN apt-get update \
    && apt-get install -y --no-install-recommends \
        chromium \
        fonts-liberation \
        ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY --from=prod-deps /app/node_modules ./node_modules
COPY package.json ./
COPY --from=builder /app/dist ./dist
COPY recipes ./recipes
COPY skills ./skills
RUN useradd --create-home --uid 10001 relabel
USER relabel
ENTRYPOINT ["node", "dist/cli.js"]
CMD ["--help"]
