# Ledger — Payment Engine (pet project)

Stripe-like payment flow skeleton: intents, capture, refunds, payouts, ledger, webhooks, reconciliation. NestJS + TypeORM + PostgreSQL.

## Requirements

- **Node.js** ≥ 20  
- **Docker** (recommended for Postgres + optional API container)

## Quick start with Docker Compose

From the repo root:

```bash
docker compose up --build
```

- API (default): [http://localhost:3050](http://localhost:3050)
- Swagger: [http://localhost:3050/docs](http://localhost:3050/docs)
- Postgres on host port **5460** (see `docker-compose.yml`; override with `HOST_DB_PORT`)

Run migrations inside the API container (first boot or after new migrations):

```bash
docker compose exec api npm run migration:run
```

## Local API + Docker Postgres only

1. Copy env: `cp .env.example .env` — point `DB_HOST` / `DB_PORT` at published Postgres (`localhost:5460` by default if only `postgres` service is up).

2. Start DB: `docker compose up -d postgres` (or full stack).

3. Install deps: `npm install`

4. Migrations: `npm run migration:run`

5. Dev server: `npm run start:dev`

## Tests

E2e tests use **real Postgres** (`test/.env.test`, port **5461** by default).

```bash
npm run test:e2e:all
```

This starts `postgres_test` (`docker compose --profile test`) and runs Jest in-band.

Single file:

```bash
npx jest --config jest-e2e.config.js --runInBand --forceExit payment-intents.create.e2e-spec.ts
```

## Scripts (see `package.json`)

| Script | Purpose |
|--------|---------|
| `npm run dev:up` / `dev:down` | Compose up/down |
| `npm run migration:run` | Apply TypeORM migrations (needs DB env) |
| `npm run test:e2e` | E2e only (DB must exist) |
| `npm run lint` / `format` | ESLint / Prettier |

## Auth (dev)

Swagger documents a seeded merchant bearer secret (`main.ts`). Use `Authorization: Bearer <secret>` on protected routes.
