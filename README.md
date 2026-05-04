# Ledger

## Why this exists / what it isn’t

Motivation came from reading about **Venetian double-entry bookkeeping**—the ledger pattern that matured in Renaissance trade and **still runs modern finance**. I wanted that same invariant (balanced books, immutable lines, correction by new entries—not edits) wired into something that *feels* like payments.

This repo is only a **learning sandbox**: not production, never aimed at prod. Weird corners are mostly intentional. Goal was to understand the mechanics; that part worked.

**Stack & scope:** payment-intent flow (mock bank), refunds, payouts, Postgres ledger, webhooks · **NestJS · TypeORM · PostgreSQL**.

**API & docs:** OpenAPI (**Swagger**) at **[http://localhost:3050/docs](http://localhost:3050/docs)**.

---

## First-time demo

```bash
npm run demo
```

1. Starts **Postgres** (`docker compose`, host port **5460**).
2. Runs **`npm ci` + migrations inside an ephemeral API container** (uses Compose DB env — no `.env` files).
3. Brings up the **API** container (`start:dev`) on the compose network.

Requires **Docker Compose** supporting `docker compose up --wait` (approximately **Compose v2.29+**). Plain Docker Desktop current builds are fine.

**Manual Compose (same idea):**

```bash
docker compose up -d --wait postgres
docker compose run --rm api sh -c "npm ci && npm run migration:run"
docker compose up --build api
```

**Host-only Nest** against compose Postgres: set `DB_HOST=localhost`, `DB_PORT=<HOST_DB_PORT default 5460>`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` (same defaults as [`docker-compose.yml`](docker-compose.yml)), then `npm install` && `npm run start:dev`.

No committed env files — **[`docker-compose.yml`](docker-compose.yml)** defines service defaults (override with Compose env vars or a local `.env` that Compose reads; both are ignored by git / build context patterns).

---

## Architecture decisions

| # | Choice | Plain English |
|---|--------|---------------|
| 1 | Ledger first | Events live in `ledger_entries`; accounts table stores types only—no cached balance column. |
| 2 | No ledger edits | DB blocks UPDATE/DELETE on posted entries; fix forward (e.g. refunds). |
| 3 | Mock bank | `/tokenize`, confirm/decline are fake; narration vs real settlement is illustrative only. |
| 4 | Three lines on capture | External credit + escrow debit (merchant net) + revenue debit (fee)—balanced posting. |
| 5 | Payout stub on capture | Pending payout row mirrors merchant net; refunds shrink/zero it ahead of settlement. |
| 6 | One merchant per secret | Bearer resolves to `merchant_id` everywhere—fine for demos. |
| 7 | Idempotency keys | Same key ⇒ same outcome; TTL ≈ **24h**; row lock prevents double create. |
| 8 | Webhooks | Payload `type`; HMAC headers; backoff **1m → 5m → 30m → 2h → 8h**; failures logged (`last_*` columns). |
| 9 | Reconciliation endpoint | Period roll-up (opening/closing, totals, movements)—not forensic accounting. |
| 10 | Workers | Internal cron ticks / HTTP tick endpoints—queues omitted on purpose for a toy. |

---

## Implemented behavior (reference)

| Area | Delivered behavior |
|------|-------------------|
| **Accounts** | No per-account stored balance—live data is `ledger_entries`. Types: escrow, revenue, merchant_payable, external. |
| **Report math** | Reconciliation opening/closing is driven by succeeded `payment_intents` plus period aggregates and movements—not a `SUM(...) GROUP BY account` snapshot in this API. (`totals.outflow.fees` still lines up with revenue-account debits in period; asserted in e2e.) Pending-payout totals track merchant net via capture/refund payout rules by design—not re-exposed as duplicate top-level totals. |
| **Payment lifecycle** | Create ⇒ `pending` (no ledger). **`POST /tokenize`** mock. Confirm ⇒ `processing` (mock authorize). Capture ⇒ `succeeded` **+ ledger (external CR, escrow + revenue DR)** + pending payout row. Decline/mock fail before capture ⇒ **`failed`**, zero ledger rows. Post-capture reversal path = **refund** with compensation only. Cancel only in **`pending`** (no ledger); **`payment.cancelled`** webhook. |
| **Payout lifecycle** | Row created when intent succeeds; **`pending`** with mock delay → worker can **`paid`** + ledger + **`payout.paid`** webhook. |
| **Ledger** | Balanced postings (capture uses 3 legs). Debit/credit signed sum targets zero when consistent (helpers in tests). References `payment_intent_id` / `refund_id` / `payout_id` where relevant. Timestamps + monotonic **`sequence_number`**. Related inserts in **one DB transaction**. |
| **Refunds** | Only on **`succeeded`**. Partial/multi-partial inside limits; new rows; revenue leg not mirrored back on partials in this model. **`pending → succeeded/failed`**; failure leaves PI intact; retry possible after failure. Refund creates idempotent with same semantics as intents. |
| **Idempotency** | **`Idempotency-Key`** required on **payment create**. Refunds: header optional—server mints an internal key if omitted; same mechanics if you pass a key. Repeat key ⇒ stored JSON result. **`INSERT … ON CONFLICT` + `FOR UPDATE`** on the idempotency row for concurrency. |
| **Webhooks** | **`payment.succeeded`, `payment.failed`, `payment.cancelled`, `refund.succeeded`, `refund.failed`, `payout.paid`** (no **`refund.created`** type in payloads). Signed + retry ladder above; persistence of delivery tries. |
| **Merchants** | Merchant scope on queries/guards (`merchant_id`). Mock decline token ⇒ failed PI, no ledger. |

---

Tests (optional):

```bash
npm run test:e2e:all
```
