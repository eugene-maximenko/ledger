import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import * as request from 'supertest';
import dataSource from '../src/database/data-source';
import {
  SEED_ARNE_API_SECRET,
  SEED_REVENUE_ACCOUNT_ID,
} from '../src/database/seed-constants';
import {
  OTHER_MERCHANT_SECRET,
  seedOtherMerchant,
  setupE2eApp,
  teardownE2eApp,
  truncateTransactionalTables,
} from './helpers/e2e-test-helpers';

let app: INestApplication | undefined;
const CAPTURE_AMOUNT = 1000;
const FEE_BPS = 300; // 3%
const BPS_BASE = 10_000;
const CAPTURE_FEE = Math.round((CAPTURE_AMOUNT * FEE_BPS) / BPS_BASE);
const MERCHANT_NET = CAPTURE_AMOUNT - CAPTURE_FEE;

beforeAll(async () => {
  app = await setupE2eApp();
});

afterAll(async () => {
  await teardownE2eApp(app);
});

describe('Reconciliation report (e2e)', () => {
  beforeEach(async () => {
    await truncateTransactionalTables();
    await seedOtherMerchant();
  });

  async function createCapturedIntent(secret: string): Promise<string> {
    const created = await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${secret}`)
      .set('Idempotency-Key', `idem-recon-${randomUUID()}`)
      .send({ amount: CAPTURE_AMOUNT, currency: 'USD' })
      .expect(201);

    await request(app!.getHttpServer())
      .post(`/payment-intents/${created.body.id}/confirm`)
      .set('Authorization', `Bearer ${secret}`)
      .send({ cardToken: 'tok_mock_123' })
      .expect(200);

    await request(app!.getHttpServer())
      .post(`/payment-intents/${created.body.id}/capture`)
      .set('Authorization', `Bearer ${secret}`)
      .send({})
      .expect(200);

    return created.body.id as string;
  }

  async function waitForRefundStatus(refundId: string, status: 'succeeded' | 'failed'): Promise<void> {
    let lastStatus: string | undefined;
    for (let i = 0; i < 50; i += 1) {
      const rows = (await dataSource.query(
        `SELECT "status" FROM "refunds" WHERE "id" = $1`,
        [refundId],
      )) as { status: string }[];
      lastStatus = rows[0]?.status;
      if (rows[0]?.status === status) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Refund ${refundId} did not reach ${status}; last status=${lastStatus ?? 'missing'}`);
  }

  it('returns summary with opening/closing and totals', async () => {
    const beforePeriodIntentId = await createCapturedIntent(SEED_ARNE_API_SECRET);
    const periodStart = new Date().toISOString();

    const periodIntentId = await createCapturedIntent(SEED_ARNE_API_SECRET);
    const refund = await request(app!.getHttpServer())
      .post(`/payment-intents/${periodIntentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 200 })
      .expect(201);
    await waitForRefundStatus(refund.body.id as string, 'succeeded');

    await dataSource.query(
      `UPDATE "payouts" SET "available_at" = NOW() - INTERVAL '1 minute' WHERE "payment_intent_id" = $1`,
      [beforePeriodIntentId],
    );
    await request(app!.getHttpServer())
      .post('/internal/workers/payout-settlement/tick')
      .expect(200);

    const periodEnd = new Date(Date.now() + 60_000).toISOString();
    const res = await request(app!.getHttpServer())
      .get('/reconciliation/report')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .query({ from: periodStart, to: periodEnd, currency: 'USD' })
      .expect(200);

    expect(res.body.merchantId).toBeTruthy();
    expect(res.body.currency).toBe('USD');
    expect(res.body.periodFrom).toBeTruthy();
    expect(res.body.periodTo).toBeTruthy();
    expect(Array.isArray(res.body.movements)).toBe(true);
    // Only period intent should affect period totals.
    expect(res.body.totals.inflow.total).toBe(CAPTURE_AMOUNT);
    expect(res.body.totals.outflow.fees).toBe(CAPTURE_FEE);
    expect(res.body.totals.outflow.refunds).toBe(200);
    expect(res.body.totals.outflow.payouts).toBe(0);
    expect(res.body.totals.outflow.total).toBe(CAPTURE_FEE + 200);
    expect(res.body.totals.net).toBe(CAPTURE_AMOUNT - (CAPTURE_FEE + 200));
    expect(res.body.movements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'capture', direction: 'in' }),
        expect.objectContaining({ type: 'refund', direction: 'out', amount: 200 }),
      ]),
    );
    expect(res.body.openingBalance).toBe(MERCHANT_NET);
    expect(res.body.closingBalance).toBe(res.body.openingBalance + res.body.totals.net);
  });

  it('keeps merchant scope and excludes other merchant activity', async () => {
    await createCapturedIntent(OTHER_MERCHANT_SECRET);
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();

    const arneRes = await request(app!.getHttpServer())
      .get('/reconciliation/report')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .query({ from, to, currency: 'USD' })
      .expect(200);

    const otherRes = await request(app!.getHttpServer())
      .get('/reconciliation/report')
      .set('Authorization', `Bearer ${OTHER_MERCHANT_SECRET}`)
      .query({ from, to, currency: 'USD' })
      .expect(200);

    expect(arneRes.body.merchantId).not.toBe(otherRes.body.merchantId);
    expect(arneRes.body.totals.inflow.total).toBe(0);
    expect(otherRes.body.totals.inflow.total).toBe(CAPTURE_AMOUNT);
  });

  it('reports revenue equal to ledger revenue entries in period', async () => {
    await createCapturedIntent(SEED_ARNE_API_SECRET);
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();

    const res = await request(app!.getHttpServer())
      .get('/reconciliation/report')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .query({ from, to, currency: 'USD' })
      .expect(200);

    const revenueRows = (await dataSource.query(
      `SELECT COALESCE(SUM("amount"), 0)::int AS s
       FROM "ledger_entries"
       WHERE "account_id" = $1 AND "type" = 'debit' AND "created_at" >= $2::timestamptz AND "created_at" <= $3::timestamptz`,
      [SEED_REVENUE_ACCOUNT_ID, from, to],
    )) as { s: number }[];

    expect(res.body.totals.outflow.fees).toBe(Number(revenueRows[0]?.s ?? 0));
  });

  it('reports correct gross, fees and merchant net after one capture', async () => {
    await createCapturedIntent(SEED_ARNE_API_SECRET);
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();

    const res = await request(app!.getHttpServer())
      .get('/reconciliation/report')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .query({ from, to, currency: 'USD' })
      .expect(200);

    expect(res.body.totals.inflow.total).toBe(CAPTURE_AMOUNT);
    expect(res.body.totals.outflow.fees).toBe(CAPTURE_FEE);
    expect(res.body.totals.net).toBe(CAPTURE_AMOUNT - CAPTURE_FEE);
    expect(res.body.movements).toHaveLength(1);
    expect(res.body.movements[0]).toMatchObject({
      type: 'capture',
      direction: 'in',
      amount: CAPTURE_AMOUNT - CAPTURE_FEE,
      gross: CAPTURE_AMOUNT,
      fee: CAPTURE_FEE,
      net: CAPTURE_AMOUNT - CAPTURE_FEE,
    });
  });

  it('reports refund impact in outflow and net', async () => {
    const intentId = await createCapturedIntent(SEED_ARNE_API_SECRET);
    const refundAmount = 200;
    const refund = await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: refundAmount })
      .expect(201);
    await waitForRefundStatus(refund.body.id as string, 'succeeded');

    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();

    const res = await request(app!.getHttpServer())
      .get('/reconciliation/report')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .query({ from, to, currency: 'USD' })
      .expect(200);

    expect(res.body.totals.inflow.total).toBe(CAPTURE_AMOUNT);
    expect(res.body.totals.outflow.fees).toBe(CAPTURE_FEE);
    expect(res.body.totals.outflow.refunds).toBe(refundAmount);
    expect(res.body.totals.outflow.payouts).toBe(0);
    expect(res.body.totals.outflow.total).toBe(CAPTURE_FEE + refundAmount);
    expect(res.body.totals.net).toBe(CAPTURE_AMOUNT - (CAPTURE_FEE + refundAmount));
    expect(res.body.movements).toHaveLength(2);
    expect(res.body.movements).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'capture', direction: 'in' }),
        expect.objectContaining({ type: 'refund', direction: 'out', amount: refundAmount }),
      ]),
    );
  });

  it('keeps escrow liability equal to pending payouts', async () => {
    const intentId = await createCapturedIntent(SEED_ARNE_API_SECRET);
    const refund = await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 200 })
      .expect(201);
    await waitForRefundStatus(refund.body.id as string, 'succeeded');

    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();

    const res = await request(app!.getHttpServer())
      .get('/reconciliation/report')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .query({ from, to, currency: 'USD' })
      .expect(200);

    expect(res.body.pendingPayouts).toBe(770);
    expect(res.body.escrowLiability).toBe(770);
    expect(res.body.escrowLiability).toBe(res.body.pendingPayouts);
  });

  it('returns 400 for invalid period range', async () => {
    const from = new Date(Date.now() + 60_000).toISOString();
    const to = new Date(Date.now() - 60_000).toISOString();

    await request(app!.getHttpServer())
      .get('/reconciliation/report')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .query({ from, to, currency: 'USD' })
      .expect(400);
  });

  it('returns zero totals and equal opening/closing for empty period', async () => {
    const from = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const to = new Date(Date.now() - 23 * 60 * 60 * 1000).toISOString();

    const res = await request(app!.getHttpServer())
      .get('/reconciliation/report')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .query({ from, to, currency: 'USD' })
      .expect(200);

    expect(res.body.openingBalance).toBe(res.body.closingBalance);
    expect(res.body.totals).toEqual(
      expect.objectContaining({
        inflow: { total: 0 },
        outflow: {
          fees: 0,
          refunds: 0,
          payouts: 0,
          total: 0,
        },
        net: 0,
      }),
    );
    expect(res.body.movements).toEqual([]);
  });

  it('returns 401 without bearer token', async () => {
    const from = new Date(Date.now() - 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();

    await request(app!.getHttpServer())
      .get('/reconciliation/report')
      .query({ from, to, currency: 'USD' })
      .expect(401);
  });
});
