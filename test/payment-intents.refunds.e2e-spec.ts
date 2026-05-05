import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import dataSource from '../src/database/data-source';
import { SEED_ARNE_API_SECRET } from '../src/database/seed-constants';
import {
  ledgerSignedSum,
  seedOtherMerchant,
  setupE2eApp,
  teardownE2eApp,
  truncateTransactionalTables,
  OTHER_MERCHANT_SECRET,
} from './helpers/e2e-test-helpers';

let app: INestApplication | undefined;

beforeAll(async () => {
  app = await setupE2eApp();
});

afterAll(async () => {
  await teardownE2eApp(app);
});

describe('POST /payment-intents/:id/refunds (e2e)', () => {
  let succeededIntentId: string;

  beforeEach(async () => {
    await truncateTransactionalTables();
    await seedOtherMerchant();
    succeededIntentId = await createSucceededIntent(`idem-refund-base-${randomUUID()}`);
  });

  afterEach(async () => {
    expect(await ledgerSignedSum()).toBe(0);
  });

  async function createSucceededIntent(idemKey: string): Promise<string> {
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

  async function waitForRefundStatus(
    refundId: string,
    status: 'pending' | 'succeeded' | 'failed',
  ): Promise<void> {
    const maxAttempts = 50;
    const delayMs = 100;
    let lastStatus: string | undefined;
    for (let i = 0; i < maxAttempts; i += 1) {
      const rows = (await dataSource.query(
        `SELECT "status" FROM "refunds" WHERE "id" = $1`,
        [refundId],
      )) as { status: string }[];
      lastStatus = rows[0]?.status;
      if (lastStatus === status) {
        return;
      }
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    throw new Error(`Refund ${refundId} did not reach ${status}; last status=${lastStatus ?? 'missing'}`);
  }

  it('creates pending refund first, then async marks it succeeded and writes mirrored ledger entries', async () => {
    const res = await request(app!.getHttpServer())
      .post(`/payment-intents/${succeededIntentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 970 })
      .expect(201);

    expect(res.body).toMatchObject({
      status: 'pending',
      amount: 970,
      paymentIntentId: succeededIntentId,
    });
    expect(res.body.id).toBeDefined();
    expect(res.body.createdAt).toBeDefined();
    await waitForRefundStatus(res.body.id, 'succeeded');

    const ledgerRows = await dataSource.query(
      `SELECT "type", "amount", "refund_id", "payment_intent_id"
       FROM "ledger_entries"
       WHERE "refund_id" = $1`,
      [res.body.id],
    );
    expect(ledgerRows).toHaveLength(2);
    expect(ledgerRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'debit',
          amount: 970,
          refund_id: res.body.id,
          payment_intent_id: null,
        }),
        expect.objectContaining({
          type: 'credit',
          amount: 970,
          refund_id: res.body.id,
          payment_intent_id: null,
        }),
      ]),
    );
  });

  it('401 without Bearer', async () => {
    await request(app!.getHttpServer())
      .post(`/payment-intents/${succeededIntentId}/refunds`)
      .send({ amount: 970 })
      .expect(401);
  });

  it('404 when intent does not exist', async () => {
    await request(app!.getHttpServer())
      .post('/payment-intents/00000000-0000-4000-8000-000000000001/refunds')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 970 })
      .expect(404);
  });

  it('404 when refunding intent from another merchant', async () => {
    await request(app!.getHttpServer())
      .post(`/payment-intents/${succeededIntentId}/refunds`)
      .set('Authorization', `Bearer ${OTHER_MERCHANT_SECRET}`)
      .send({ amount: 970 })
      .expect(404);
  });

  it('400 when intent id is not a valid uuid', async () => {
    await request(app!.getHttpServer())
      .post('/payment-intents/d7d5f9ba-b86e-4af3-8b75-13a726346ed/refunds')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 970 })
      .expect(400);
  });

  it('400 when refund body is missing amount', async () => {
    await request(app!.getHttpServer())
      .post(`/payment-intents/${succeededIntentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({})
      .expect(400);
  });

  it('400 when refund amount is not positive', async () => {
    await request(app!.getHttpServer())
      .post(`/payment-intents/${succeededIntentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 0 })
      .expect(400);
  });

  it('400 when refund body contains unexpected fields', async () => {
    await request(app!.getHttpServer())
      .post(`/payment-intents/${succeededIntentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 970, unexpected: 'field' })
      .expect(400);
  });

  it('409 when payment is not succeeded', async () => {
    const created = await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', `idem-refund-wrong-state-${randomUUID()}`)
      .send({ amount: 1000, currency: 'USD' })
      .expect(201);

    await request(app!.getHttpServer())
      .post(`/payment-intents/${created.body.id}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 970 })
      .expect(409);
  });

  it('409 when refund amount exceeds refundable_left', async () => {
    await request(app!.getHttpServer())
      .post(`/payment-intents/${succeededIntentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 971 })
      .expect(409);
  });

  it('rejects any extra refund after refundable amount is fully exhausted', async () => {
    const first = await request(app!.getHttpServer())
      .post(`/payment-intents/${succeededIntentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 970 })
      .expect(201);
    await waitForRefundStatus(first.body.id, 'succeeded');

    await request(app!.getHttpServer())
      .post(`/payment-intents/${succeededIntentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 1 })
      .expect(409);

    const totals = (await dataSource.query(
      `SELECT COALESCE(SUM("amount"), 0)::text AS total
       FROM "refunds"
       WHERE "payment_intent_id" = $1 AND "status" = 'succeeded'`,
      [succeededIntentId],
    )) as { total: string }[];
    expect(Number(totals[0]?.total ?? 0)).toBe(970);
  });

  it('returns same refund for same Idempotency-Key and does not duplicate rows', async () => {
    const first = await request(app!.getHttpServer())
      .post(`/payment-intents/${succeededIntentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', 'idem-refund-dup')
      .send({ amount: 485 })
      .expect(201);

    const second = await request(app!.getHttpServer())
      .post(`/payment-intents/${succeededIntentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', 'idem-refund-dup')
      .send({ amount: 970 })
      .expect(201);

    expect(second.body).toEqual(first.body);

    const refunds = await dataSource.query(
      `SELECT * FROM "refunds" WHERE "payment_intent_id" = $1`,
      [succeededIntentId],
    );
    expect(refunds).toHaveLength(1);
  });

  it('allows partial refund (example: 30 out of refundable 970)', async () => {
    const partial = await request(app!.getHttpServer())
      .post(`/payment-intents/${succeededIntentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 30 })
      .expect(201);

    expect(partial.body).toMatchObject({
      status: 'pending',
      amount: 30,
      paymentIntentId: succeededIntentId,
    });
    await waitForRefundStatus(partial.body.id, 'succeeded');

    const refundRows = await dataSource.query(
      `SELECT "status", "amount" FROM "refunds" WHERE "id" = $1`,
      [partial.body.id],
    );
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0].status).toBe('succeeded');
    expect(Number(refundRows[0].amount)).toBe(30);
  });

  it('allows multiple partial refunds when total does not exceed original refundable amount', async () => {
    const first = await request(app!.getHttpServer())
      .post(`/payment-intents/${succeededIntentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 485 })
      .expect(201);

    const second = await request(app!.getHttpServer())
      .post(`/payment-intents/${succeededIntentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 485 })
      .expect(201);

    expect(first.body.status).toBe('pending');
    expect(second.body.status).toBe('pending');
    await waitForRefundStatus(first.body.id, 'succeeded');
    await waitForRefundStatus(second.body.id, 'succeeded');

    const refunds = await dataSource.query(
      `SELECT "id", "amount" FROM "refunds" WHERE "payment_intent_id" = $1 ORDER BY "created_at" ASC`,
      [succeededIntentId],
    );
    expect(refunds).toHaveLength(2);
    expect(Number(refunds[0].amount)).toBe(485);
    expect(Number(refunds[1].amount)).toBe(485);

    const ledgerFirst = await dataSource.query(
      `SELECT "refund_id", "payment_intent_id" FROM "ledger_entries" WHERE "refund_id" = $1`,
      [refunds[0].id],
    );
    const ledgerSecond = await dataSource.query(
      `SELECT "refund_id", "payment_intent_id" FROM "ledger_entries" WHERE "refund_id" = $1`,
      [refunds[1].id],
    );
    expect(ledgerFirst).toHaveLength(2);
    expect(ledgerSecond).toHaveLength(2);
    expect(ledgerFirst.every((row: { refund_id: string; payment_intent_id: string | null }) => (
      row.refund_id === refunds[0].id && row.payment_intent_id === null
    ))).toBe(true);
    expect(ledgerSecond.every((row: { refund_id: string; payment_intent_id: string | null }) => (
      row.refund_id === refunds[1].id && row.payment_intent_id === null
    ))).toBe(true);
  });

  it('handles concurrent full refund requests: one succeeds, one conflicts', async () => {
    const server = app!.getHttpServer();
    const headers = {
      Authorization: `Bearer ${SEED_ARNE_API_SECRET}`,
      'Content-Type': 'application/json',
    };

    const [a, b] = await Promise.all([
      request(server)
        .post(`/payment-intents/${succeededIntentId}/refunds`)
        .set(headers)
        .send({ amount: 970 }),
      request(server)
        .post(`/payment-intents/${succeededIntentId}/refunds`)
        .set(headers)
        .send({ amount: 970 }),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([201, 409]);
    const pending = a.status === 201 ? a.body : b.body;
    await waitForRefundStatus(pending.id, 'succeeded');

    const refunds = await dataSource.query(
      `SELECT "status", "amount" FROM "refunds" WHERE "payment_intent_id" = $1`,
      [succeededIntentId],
    );
    expect(refunds).toHaveLength(1);
    expect(refunds[0].status).toBe('succeeded');
    expect(Number(refunds[0].amount)).toBe(970);
  });

  it('rejects partial refund that would exceed remaining refundable amount', async () => {
    const first = await request(app!.getHttpServer())
      .post(`/payment-intents/${succeededIntentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 485 })
      .expect(201);
    await waitForRefundStatus(first.body.id, 'succeeded');

    await request(app!.getHttpServer())
      .post(`/payment-intents/${succeededIntentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 486 })
      .expect(409);
  });

  it('marks refund as failed when mock-bank reverse declines and does not create ledger entries', async () => {
    await dataSource.query(
      `UPDATE "payment_intents" SET "capture_id" = $1 WHERE "id" = $2`,
      ['cap_decline_refund', succeededIntentId],
    );

    const failed = await request(app!.getHttpServer())
      .post(`/payment-intents/${succeededIntentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 970 })
      .expect(201);
    await waitForRefundStatus(failed.body.id, 'failed');

    expect(failed.body).toMatchObject({
      status: 'pending',
      amount: 970,
      paymentIntentId: succeededIntentId,
    });

    const refundRows = await dataSource.query(
      `SELECT "status" FROM "refunds" WHERE "id" = $1`,
      [failed.body.id],
    );
    expect(refundRows).toHaveLength(1);
    expect(refundRows[0].status).toBe('failed');

    const ledgerRows = await dataSource.query(
      `SELECT * FROM "ledger_entries" WHERE "refund_id" = $1`,
      [failed.body.id],
    );
    expect(ledgerRows).toHaveLength(0);
  });

  it('allows creating a new refund after previous refund failed', async () => {
    await dataSource.query(
      `UPDATE "payment_intents" SET "capture_id" = $1 WHERE "id" = $2`,
      ['cap_decline_refund', succeededIntentId],
    );

    const failed = await request(app!.getHttpServer())
      .post(`/payment-intents/${succeededIntentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 970 })
      .expect(201);
    expect(failed.body.status).toBe('pending');
    await waitForRefundStatus(failed.body.id, 'failed');

    await dataSource.query(
      `UPDATE "payment_intents" SET "capture_id" = $1 WHERE "id" = $2`,
      ['cap_ok_retry_refund', succeededIntentId],
    );

    const retried = await request(app!.getHttpServer())
      .post(`/payment-intents/${succeededIntentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 970 })
      .expect(201);
    await waitForRefundStatus(retried.body.id, 'succeeded');

    expect(retried.body).toMatchObject({
      status: 'pending',
      amount: 970,
      paymentIntentId: succeededIntentId,
    });

    const refundRows = await dataSource.query(
      `SELECT "status", "amount" FROM "refunds" WHERE "payment_intent_id" = $1 ORDER BY "created_at" ASC`,
      [succeededIntentId],
    );
    expect(refundRows).toHaveLength(2);
    expect(refundRows[0].status).toBe('failed');
    expect(Number(refundRows[0].amount)).toBe(970);
    expect(refundRows[1].status).toBe('succeeded');
    expect(Number(refundRows[1].amount)).toBe(970);

    const retriedLedgerRows = await dataSource.query(
      `SELECT "type", "amount", "refund_id", "payment_intent_id"
       FROM "ledger_entries"
       WHERE "refund_id" = $1`,
      [retried.body.id],
    );
    expect(retriedLedgerRows).toHaveLength(2);
    expect(retriedLedgerRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'debit',
          amount: 970,
          refund_id: retried.body.id,
          payment_intent_id: null,
        }),
        expect.objectContaining({
          type: 'credit',
          amount: 970,
          refund_id: retried.body.id,
          payment_intent_id: null,
        }),
      ]),
    );
  });
});
