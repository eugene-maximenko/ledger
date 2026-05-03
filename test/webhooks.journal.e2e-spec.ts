import { INestApplication } from '@nestjs/common';
import { randomUUID } from 'crypto';
import request from 'supertest';
import dataSource from '../src/database/data-source';
import { SEED_ARNE_API_SECRET } from '../src/database/seed-constants';
import {
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

describe('Webhook journal events (e2e)', () => {
  beforeEach(async () => {
    await truncateTransactionalTables();
  });

  async function createPendingIntent(idemKey: string): Promise<string> {
    const created = await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', idemKey)
      .send({ amount: 1000, currency: 'USD' })
      .expect(201);
    return created.body.id as string;
  }

  async function createCapturedIntent(idemKey: string): Promise<string> {
    const intentId = await createPendingIntent(idemKey);

    await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/confirm`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ cardToken: 'tok_mock_123' })
      .expect(200);

    await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/capture`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({})
      .expect(200);

    return intentId;
  }

  async function waitForRefundStatus(
    refundId: string,
    status: 'succeeded' | 'failed',
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
    throw new Error(`Refund ${refundId} did not reach ${status}; last=${lastStatus ?? 'missing'} (>${maxAttempts * delayMs}ms)`);
  }

  async function expectPendingWebhookEvent(
    eventType: string,
    refs: {
      paymentIntentId?: string | null;
      refundId?: string | null;
      payoutId?: string | null;
    },
  ): Promise<void> {
    const rows = await dataSource.query(
      `SELECT "event_type", "status", "failed_attempts", "next_retry_at", "payment_intent_id", "refund_id", "payout_id"
       FROM "webhook_events"
       WHERE "event_type" = $1
       ORDER BY "created_at" DESC
       LIMIT 1`,
      [eventType],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].event_type).toBe(eventType);
    expect(rows[0].status).toBe('pending');
    expect(Number(rows[0].failed_attempts)).toBe(0);
    expect(rows[0].next_retry_at).toBeNull();
    expect(rows[0].payment_intent_id).toBe(refs.paymentIntentId ?? null);
    expect(rows[0].refund_id).toBe(refs.refundId ?? null);
    expect(rows[0].payout_id).toBe(refs.payoutId ?? null);
  }

  it('creates payment.succeeded webhook journal event on capture', async () => {
    const intentId = await createCapturedIntent(`idem-webhook-payment-succeeded-${randomUUID()}`);

    await expectPendingWebhookEvent('payment.succeeded', {
      paymentIntentId: intentId,
      refundId: null,
      payoutId: null,
    });
  });

  it('creates payment.failed webhook journal event on declined authorize', async () => {
    const intentId = await createPendingIntent(`idem-webhook-payment-failed-${randomUUID()}`);

    await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/confirm`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ cardToken: 'tok_decline_card_declined' })
      .expect(200);

    await expectPendingWebhookEvent('payment.failed', {
      paymentIntentId: intentId,
      refundId: null,
      payoutId: null,
    });
  });

  it('creates payment.cancelled webhook journal event on cancel', async () => {
    const intentId = await createPendingIntent(`idem-webhook-payment-cancelled-${randomUUID()}`);

    await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/cancel`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({})
      .expect(200);

    await expectPendingWebhookEvent('payment.cancelled', {
      paymentIntentId: intentId,
      refundId: null,
      payoutId: null,
    });
  });

  it('creates refund.succeeded webhook journal event on successful refund', async () => {
    const intentId = await createCapturedIntent(`idem-webhook-refund-succeeded-${randomUUID()}`);

    const refund = await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 970 })
      .expect(201);

    await waitForRefundStatus(refund.body.id as string, 'succeeded');
    await expectPendingWebhookEvent('refund.succeeded', {
      paymentIntentId: null,
      refundId: refund.body.id as string,
      payoutId: null,
    });
  });

  it('creates refund.failed webhook journal event on failed refund', async () => {
    const intentId = await createCapturedIntent(`idem-webhook-refund-failed-${randomUUID()}`);

    await dataSource.query(
      `UPDATE "payment_intents" SET "capture_id" = $1 WHERE "id" = $2`,
      ['cap_decline_refund', intentId],
    );

    const refund = await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/refunds`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 970 })
      .expect(201);

    await waitForRefundStatus(refund.body.id as string, 'failed');
    await expectPendingWebhookEvent('refund.failed', {
      paymentIntentId: null,
      refundId: refund.body.id as string,
      payoutId: null,
    });
  });

  it('creates payout.paid webhook journal event when payout is settled', async () => {
    const intentId = await createCapturedIntent(`idem-webhook-payout-paid-${randomUUID()}`);
    const payoutRows = (await dataSource.query(
      `SELECT "id" FROM "payouts" WHERE "payment_intent_id" = $1 LIMIT 1`,
      [intentId],
    )) as { id: string }[];
    const payoutId = payoutRows[0]?.id;
    expect(payoutId).toBeDefined();

    await dataSource.query(
      `UPDATE "payouts" SET "available_at" = NOW() - INTERVAL '1 minute' WHERE "id" = $1`,
      [payoutId],
    );
    await request(app!.getHttpServer())
      .post('/internal/workers/payout-settlement/tick')
      .expect(200);

    await expectPendingWebhookEvent('payout.paid', {
      paymentIntentId: null,
      refundId: null,
      payoutId,
    });
  });
});
