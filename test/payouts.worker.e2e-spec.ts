import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import dataSource from '../src/database/data-source';
import {
  SEED_ARNE_API_SECRET,
  SEED_ESCROW_ACCOUNT_ID,
  SEED_MERCHANT_PAYABLE_ACCOUNT_ID,
} from '../src/database/seed-constants';
import {
  ledgerSignedSum,
  seedOtherMerchant,
  setupE2eApp,
  teardownE2eApp,
  truncateTransactionalTables,
} from './helpers/e2e-test-helpers';

let app: INestApplication | undefined;

beforeAll(async () => {
  app = await setupE2eApp();
});

afterAll(async () => {
  await teardownE2eApp(app);
});

describe('Payout settlement worker (e2e)', () => {
  beforeEach(async () => {
    await truncateTransactionalTables();
    await seedOtherMerchant();
  });

  afterEach(async () => {
    expect(await ledgerSignedSum()).toBe(0);
  });

  async function createCapturedIntent(idemKey: string): Promise<string> {
    const created = await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', idemKey)
      .send({ amount: 1000, currency: 'USD' })
      .expect(201);

    await request(app!.getHttpServer())
      .post(`/payment-intents/${created.body.id}/confirm`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ cardToken: 'tok_mock_123' })
      .expect(200);

    await request(app!.getHttpServer())
      .post(`/payment-intents/${created.body.id}/capture`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({})
      .expect(200);

    return created.body.id as string;
  }

  async function waitForRefundSucceeded(refundId: string): Promise<void> {
    const maxAttempts = 50;
    const delayMs = 100;
    let lastStatus: string | undefined;
    for (let i = 0; i < maxAttempts; i += 1) {
      const rows = (await dataSource.query(
        `SELECT "status" FROM "refunds" WHERE "id" = $1`,
        [refundId],
      )) as { status: string }[];
      lastStatus = rows[0]?.status;
      if (lastStatus === 'succeeded') {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`Refund ${refundId} did not reach succeeded; last status=${lastStatus ?? 'missing'}`);
  }

  it('moves due pending payout to paid and writes settlement ledger entries', async () => {
    const intentId = await createCapturedIntent('idem-payout-worker-due');
    const payouts = (await dataSource.query(
      `SELECT "id" FROM "payouts" WHERE "payment_intent_id" = $1`,
      [intentId],
    )) as { id: string }[];
    const payoutId = payouts[0]?.id;
    expect(payoutId).toBeDefined();

    await dataSource.query(
      `UPDATE "payouts" SET "available_at" = NOW() - INTERVAL '1 minute' WHERE "id" = $1`,
      [payoutId],
    );

    await request(app!.getHttpServer())
      .post('/internal/workers/payout-settlement/tick')
      .expect(200);

    const rows = await dataSource.query(
      `SELECT "status" FROM "payouts" WHERE "id" = $1`,
      [payoutId],
    );
    expect(rows[0].status).toBe('paid');

    const settlementLedgerRows = await dataSource.query(
      `SELECT "account_id", "type", "amount", "payout_id"
       FROM "ledger_entries"
       WHERE "payout_id" = $1`,
      [payoutId],
    );
    expect(settlementLedgerRows).toHaveLength(2);
    expect(settlementLedgerRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_id: SEED_ESCROW_ACCOUNT_ID,
          type: 'debit',
          amount: 970,
          payout_id: payoutId,
        }),
        expect.objectContaining({
          account_id: SEED_MERCHANT_PAYABLE_ACCOUNT_ID,
          type: 'credit',
          amount: 970,
          payout_id: payoutId,
        }),
      ]),
    );
  });

  it('does not settle payouts that are not due yet', async () => {
    const intentId = await createCapturedIntent('idem-payout-worker-not-due');
    const payouts = (await dataSource.query(
      `SELECT "id" FROM "payouts" WHERE "payment_intent_id" = $1`,
      [intentId],
    )) as { id: string }[];
    const payoutId = payouts[0]?.id;

    await request(app!.getHttpServer())
      .post('/internal/workers/payout-settlement/tick')
      .expect(200);

    const rows = await dataSource.query(
      `SELECT "status" FROM "payouts" WHERE "id" = $1`,
      [payoutId],
    );
    expect(rows[0].status).toBe('pending');

    const settlementLedgerRows = await dataSource.query(
      `SELECT * FROM "ledger_entries" WHERE "payout_id" = $1`,
      [payoutId],
    );
    expect(settlementLedgerRows).toHaveLength(0);
  });

  it('is idempotent on repeated worker ticks', async () => {
    const intentId = await createCapturedIntent('idem-payout-worker-idempotent');
    const payouts = (await dataSource.query(
      `SELECT "id" FROM "payouts" WHERE "payment_intent_id" = $1`,
      [intentId],
    )) as { id: string }[];
    const payoutId = payouts[0]?.id;

    await dataSource.query(
      `UPDATE "payouts" SET "available_at" = NOW() - INTERVAL '1 minute' WHERE "id" = $1`,
      [payoutId],
    );

    await request(app!.getHttpServer())
      .post('/internal/workers/payout-settlement/tick')
      .expect(200);
    await request(app!.getHttpServer())
      .post('/internal/workers/payout-settlement/tick')
      .expect(200);

    const rows = await dataSource.query(
      `SELECT "status" FROM "payouts" WHERE "id" = $1`,
      [payoutId],
    );
    expect(rows[0].status).toBe('paid');

    const settlementLedgerRows = await dataSource.query(
      `SELECT * FROM "ledger_entries" WHERE "payout_id" = $1`,
      [payoutId],
    );
    expect(settlementLedgerRows).toHaveLength(2);
  });

  it('handles concurrent worker ticks without duplicating settlement entries', async () => {
    const intentId = await createCapturedIntent('idem-payout-worker-concurrent');
    const payouts = (await dataSource.query(
      `SELECT "id" FROM "payouts" WHERE "payment_intent_id" = $1`,
      [intentId],
    )) as { id: string }[];
    const payoutId = payouts[0]?.id;

    await dataSource.query(
      `UPDATE "payouts" SET "available_at" = NOW() - INTERVAL '1 minute' WHERE "id" = $1`,
      [payoutId],
    );

    const server = app!.getHttpServer();
    const [a, b] = await Promise.all([
      request(server).post('/internal/workers/payout-settlement/tick'),
      request(server).post('/internal/workers/payout-settlement/tick'),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 200]);

    const rows = await dataSource.query(
      `SELECT "status" FROM "payouts" WHERE "id" = $1`,
      [payoutId],
    );
    expect(rows[0].status).toBe('paid');

    const settlementLedgerRows = await dataSource.query(
      `SELECT * FROM "ledger_entries" WHERE "payout_id" = $1`,
      [payoutId],
    );
    expect(settlementLedgerRows).toHaveLength(2);
  });

  it('does not touch already paid payout on repeated tick', async () => {
    const intentId = await createCapturedIntent('idem-payout-worker-already-paid');
    const payouts = (await dataSource.query(
      `SELECT "id" FROM "payouts" WHERE "payment_intent_id" = $1`,
      [intentId],
    )) as { id: string }[];
    const payoutId = payouts[0]?.id;

    await dataSource.query(
      `UPDATE "payouts" SET "available_at" = NOW() - INTERVAL '1 minute' WHERE "id" = $1`,
      [payoutId],
    );

    await request(app!.getHttpServer())
      .post('/internal/workers/payout-settlement/tick')
      .expect(200);

    const before = await dataSource.query(
      `SELECT "id" FROM "ledger_entries" WHERE "payout_id" = $1 ORDER BY "sequence_number"`,
      [payoutId],
    );
    expect(before).toHaveLength(2);

    await request(app!.getHttpServer())
      .post('/internal/workers/payout-settlement/tick')
      .expect(200);

    const after = await dataSource.query(
      `SELECT "id" FROM "ledger_entries" WHERE "payout_id" = $1 ORDER BY "sequence_number"`,
      [payoutId],
    );
    expect(after).toHaveLength(2);
    expect(after.map((row: { id: string }) => row.id)).toEqual(
      before.map((row: { id: string }) => row.id),
    );
  });

  it('settles reduced payout amount after succeeded partial refund', async () => {
    const intentId = await createCapturedIntent('idem-payout-after-partial-refund');
    const payoutRows = (await dataSource.query(
      `SELECT "id", "amount" FROM "payouts" WHERE "payment_intent_id" = $1`,
      [intentId],
    )) as { id: string; amount: number }[];
    const payoutId = payoutRows[0]?.id;
    expect(payoutRows[0]?.amount).toBe(970);

    const refund = await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 200 })
      .expect(201);
    await waitForRefundSucceeded(refund.body.id as string);

    await dataSource.query(
      `UPDATE "payouts" SET "available_at" = NOW() - INTERVAL '1 minute' WHERE "id" = $1`,
      [payoutId],
    );

    await request(app!.getHttpServer())
      .post('/internal/workers/payout-settlement/tick')
      .expect(200);

    const afterPayout = await dataSource.query(
      `SELECT "status", "amount" FROM "payouts" WHERE "id" = $1`,
      [payoutId],
    );
    expect(afterPayout[0].status).toBe('paid');
    expect(Number(afterPayout[0].amount)).toBe(770);

    const settlementLedgerRows = await dataSource.query(
      `SELECT "account_id", "type", "amount" FROM "ledger_entries" WHERE "payout_id" = $1`,
      [payoutId],
    );
    expect(settlementLedgerRows).toHaveLength(2);
    expect(settlementLedgerRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          account_id: SEED_ESCROW_ACCOUNT_ID,
          type: 'debit',
          amount: 770,
        }),
        expect.objectContaining({
          account_id: SEED_MERCHANT_PAYABLE_ACCOUNT_ID,
          type: 'credit',
          amount: 770,
        }),
      ]),
    );
  });

  it('rejects settlement when payout amount exceeds refundable-adjusted payable', async () => {
    const intentId = await createCapturedIntent('idem-payout-worker-overpay-guard');
    const payoutRows = (await dataSource.query(
      `SELECT "id" FROM "payouts" WHERE "payment_intent_id" = $1`,
      [intentId],
    )) as { id: string }[];
    const payoutId = payoutRows[0]?.id;
    expect(payoutId).toBeDefined();

    const refund = await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 200 })
      .expect(201);
    expect(refund.body.id).toBeDefined();
    await waitForRefundSucceeded(refund.body.id as string);

    await dataSource.query(
      `UPDATE "payouts"
       SET "amount" = 970, "available_at" = NOW() - INTERVAL '1 minute'
       WHERE "id" = $1`,
      [payoutId],
    );

    await request(app!.getHttpServer())
      .post('/internal/workers/payout-settlement/tick')
      .expect(500);

    const statusRows = await dataSource.query(
      `SELECT "status" FROM "payouts" WHERE "id" = $1`,
      [payoutId],
    );
    expect(statusRows[0].status).toBe('pending');

    const settlementLedgerRows = await dataSource.query(
      `SELECT * FROM "ledger_entries" WHERE "payout_id" = $1`,
      [payoutId],
    );
    expect(settlementLedgerRows).toHaveLength(0);
  });

  it('marks payout as cancelled after full refund before settlement', async () => {
    const intentId = await createCapturedIntent('idem-payout-full-refund-cancelled');
    const payoutRows = (await dataSource.query(
      `SELECT "id", "amount", "status" FROM "payouts" WHERE "payment_intent_id" = $1`,
      [intentId],
    )) as { id: string; amount: number; status: string }[];
    const payoutId = payoutRows[0]?.id;
    expect(payoutRows[0]?.amount).toBe(970);
    expect(payoutRows[0]?.status).toBe('pending');

    const refund = await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 970 })
      .expect(201);
    await waitForRefundSucceeded(refund.body.id as string);

    const afterRefundPayoutRows = await dataSource.query(
      `SELECT "status", "amount" FROM "payouts" WHERE "id" = $1`,
      [payoutId],
    );
    expect(afterRefundPayoutRows[0].status).toBe('cancelled');
    expect(Number(afterRefundPayoutRows[0].amount)).toBe(0);
  });

  it('does not settle cancelled payout on worker tick', async () => {
    const intentId = await createCapturedIntent('idem-payout-cancelled-no-settle');
    const payoutRows = (await dataSource.query(
      `SELECT "id" FROM "payouts" WHERE "payment_intent_id" = $1`,
      [intentId],
    )) as { id: string }[];
    const payoutId = payoutRows[0]?.id;

    await dataSource.query(
      `UPDATE "payouts"
       SET "status" = 'cancelled', "amount" = 0, "available_at" = NOW() - INTERVAL '1 minute'
       WHERE "id" = $1`,
      [payoutId],
    );

    await request(app!.getHttpServer())
      .post('/internal/workers/payout-settlement/tick')
      .expect(200);

    const rows = await dataSource.query(
      `SELECT "status", "amount" FROM "payouts" WHERE "id" = $1`,
      [payoutId],
    );
    expect(rows[0].status).toBe('cancelled');
    expect(Number(rows[0].amount)).toBe(0);

    const settlementLedgerRows = await dataSource.query(
      `SELECT * FROM "ledger_entries" WHERE "payout_id" = $1`,
      [payoutId],
    );
    expect(settlementLedgerRows).toHaveLength(0);
  });
});
