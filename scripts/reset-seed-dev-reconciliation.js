const { Client } = require('pg');
const crypto = require('crypto');

const BASE_URL = 'http://localhost:3050';
const AUTH = 'Bearer dev_arne_sk_test_01';

async function req(method, path, body, headers = {}) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'content-type': 'application/json',
      ...headers,
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : {};
}

async function createCapturedIntent() {
  const created = await req(
    'POST',
    '/payment-intents',
    { amount: 1000, currency: 'USD' },
    {
      Authorization: AUTH,
      'Idempotency-Key': `seed-${crypto.randomUUID()}`,
    },
  );
  await req(
    'POST',
    `/payment-intents/${created.id}/confirm`,
    { cardToken: 'tok_mock_123' },
    { Authorization: AUTH },
  );
  await req(
    'POST',
    `/payment-intents/${created.id}/capture`,
    {},
    { Authorization: AUTH },
  );
  return created.id;
}

async function waitRefundSucceeded(pg, refundId) {
  for (let i = 0; i < 80; i += 1) {
    const rows = await pg.query('SELECT "status" FROM "refunds" WHERE "id" = $1', [refundId]);
    if (rows.rows[0]?.status === 'succeeded') {
      return;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`Refund timeout for ${refundId}`);
}

async function main() {
  const pg = new Client({
    host: 'localhost',
    port: 5460,
    user: 'ledger',
    password: 'ledger',
    database: 'ledger',
  });

  await pg.connect();
  try {
    await pg.query(
      'TRUNCATE TABLE "webhook_events", "ledger_entries", "payouts", "refunds", "payment_intents", "idempotency_keys" RESTART IDENTITY CASCADE',
    );
    await pg.query('ALTER SEQUENCE "ledger_entry_sequence_seq" RESTART WITH 1');

    const intents = [];
    for (let i = 0; i < 5; i += 1) {
      intents.push(await createCapturedIntent());
    }

    // Freeze all payouts in future first so cron cannot auto-pay all five.
    await pg.query(
      `UPDATE "payouts"
       SET "available_at" = NOW() + INTERVAL '365 days'
       WHERE "payment_intent_id" = ANY($1::uuid[])`,
      [intents],
    );

    // Create refunds on still-pending payout intents to avoid overpaying refunded intents.
    const partial = await req(
      'POST',
      `/payment-intents/${intents[2]}/refunds`,
      { amount: 200 },
      { Authorization: AUTH },
    );
    const full = await req(
      'POST',
      `/payment-intents/${intents[3]}/refunds`,
      { amount: 970 },
      { Authorization: AUTH },
    );

    await waitRefundSucceeded(pg, partial.id);
    await waitRefundSucceeded(pg, full.id);

    await pg.query(
      `UPDATE "payouts"
       SET "available_at" = NOW() - INTERVAL '1 minute'
       WHERE "payment_intent_id" IN ($1, $2)`,
      [intents[0], intents[1]],
    );
    await req('POST', '/internal/workers/payout-settlement/tick', {});

    const summary = await pg.query(
      `SELECT
        (SELECT COUNT(*) FROM "payment_intents") AS intents,
        (SELECT COUNT(*) FROM "refunds" WHERE "status" = 'succeeded') AS refunds_succeeded,
        (SELECT COUNT(*) FROM "payouts" WHERE "status" = 'paid') AS payouts_paid,
        (SELECT COUNT(*) FROM "payouts" WHERE "status" = 'pending') AS payouts_pending`,
    );

    console.log(summary.rows[0]);
  } finally {
    await pg.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
