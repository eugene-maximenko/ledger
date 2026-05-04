# syntax=docker/dockerfile:1
FROM node:22-bookworm-slim AS base

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./

# Lockfile → deterministic tree; npm cache mount speeds rebuilds (BuildKit on).
RUN --mount=type=cache,target=/root/.npm \
    npm ci

COPY . .

EXPOSE 3050

# Default CMD is overwritten by docker-compose (start:dev).
CMD ["npm", "run", "start:dev"]
