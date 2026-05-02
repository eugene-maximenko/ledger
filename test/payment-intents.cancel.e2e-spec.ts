import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import dataSource from '../src/database/data-source';
import { SEED_ARNE_API_SECRET, SEED_ARNE_MERCHANT_ID } from '../src/database/seed-constants';
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

describe('POST /payment-intents/:id/cancel (e2e)', () => {
  beforeEach(async () => {
    await truncateTransactionalTables();
    await seedOtherMerchant();
  });

  afterEach(async () => {
    expect(await ledgerSignedSum()).toBe(0);
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

  it('cancels pending intent and returns cancelled status', async () => {
    const intentId = await createPendingIntent('idem-cancel-happy');

    const res = await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/cancel`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({})
      .expect(200);

    expect(res.body).toMatchObject({
      id: intentId,
      status: 'cancelled',
      amount: 1000,
      currency: 'USD',
      merchantId: SEED_ARNE_MERCHANT_ID,
    });
    expect(res.body.captureId).toBeUndefined();
    expect(res.body.capture_id).toBeUndefined();
    expect(res.body.authCode).toBeUndefined();
    expect(res.body.auth_code).toBeUndefined();

    const rows = await dataSource.query(
      `SELECT "status" FROM "payment_intents" WHERE "id" = $1`,
      [intentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('cancelled');
  });

  it('401 without Bearer', async () => {
    const intentId = await createPendingIntent('idem-cancel-no-bearer');

    await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/cancel`)
      .send({})
      .expect(401);
  });

  it('404 when intent does not exist', async () => {
    await request(app!.getHttpServer())
      .post('/payment-intents/00000000-0000-4000-8000-000000000001/cancel')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({})
      .expect(404);
  });

  it('404 when cancelling intent from another merchant', async () => {
    const intentId = await createPendingIntent('idem-cancel-foreign');

    await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/cancel`)
      .set('Authorization', `Bearer ${OTHER_MERCHANT_SECRET}`)
      .send({})
      .expect(404);
  });

  it('400 when intent id is not a valid uuid', async () => {
    await request(app!.getHttpServer())
      .post('/payment-intents/d7d5f9ba-b86e-4af3-8b75-13a726346ed/cancel')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({})
      .expect(400);
  });

  it('409 when intent is not pending (processing)', async () => {
    const intentId = await createPendingIntent('idem-cancel-wrong-state-processing');

    await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/confirm`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ cardToken: 'tok_mock_123' })
      .expect(200);

    await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/cancel`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({})
      .expect(409);
  });

  it('409 when intent is not pending (failed)', async () => {
    const intentId = await createPendingIntent('idem-cancel-wrong-state-failed');

    await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/confirm`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ cardToken: 'tok_decline_card_declined' })
      .expect(200);

    await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/cancel`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({})
      .expect(409);
  });

  it('409 when intent is not pending (succeeded)', async () => {
    const intentId = await createPendingIntent('idem-cancel-wrong-state-succeeded');

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

    await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/cancel`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({})
      .expect(409);
  });

  it('400 when body is not empty (explicit empty DTO contract)', async () => {
    const intentId = await createPendingIntent('idem-cancel-body');

    await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/cancel`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ unexpected: 'field' })
      .expect(400);
  });

  it('does not create ledger entries or payouts when cancelling pending intent', async () => {
    const intentId = await createPendingIntent('idem-cancel-no-side-effects');

    await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/cancel`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({})
      .expect(200);

    const ledgerRows = await dataSource.query(
      `SELECT * FROM "ledger_entries" WHERE "payment_intent_id" = $1`,
      [intentId],
    );
    expect(ledgerRows).toHaveLength(0);

    const payouts = await dataSource.query(
      `SELECT * FROM "payouts" WHERE "payment_intent_id" = $1`,
      [intentId],
    );
    expect(payouts).toHaveLength(0);
  });

  it('handles concurrent cancel requests: one succeeds, one conflicts', async () => {
    const intentId = await createPendingIntent('idem-cancel-race');
    const server = app!.getHttpServer();
    const headers = {
      Authorization: `Bearer ${SEED_ARNE_API_SECRET}`,
      'Content-Type': 'application/json',
    };

    const [a, b] = await Promise.all([
      request(server).post(`/payment-intents/${intentId}/cancel`).set(headers).send({}),
      request(server).post(`/payment-intents/${intentId}/cancel`).set(headers).send({}),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const rows = await dataSource.query(
      `SELECT "status" FROM "payment_intents" WHERE "id" = $1`,
      [intentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('cancelled');
  });

  it('handles concurrent cancel and confirm: exactly one succeeds', async () => {
    const intentId = await createPendingIntent('idem-cancel-confirm-race');
    const server = app!.getHttpServer();
    const authHeaders = {
      Authorization: `Bearer ${SEED_ARNE_API_SECRET}`,
      'Content-Type': 'application/json',
    };

    const [cancelRes, confirmRes] = await Promise.all([
      request(server).post(`/payment-intents/${intentId}/cancel`).set(authHeaders).send({}),
      request(server)
        .post(`/payment-intents/${intentId}/confirm`)
        .set(authHeaders)
        .send({ cardToken: 'tok_mock_123' }),
    ]);

    const statuses = [cancelRes.status, confirmRes.status].sort();
    expect(statuses).toEqual([200, 409]);

    const rows = await dataSource.query(
      `SELECT "status", "auth_code" FROM "payment_intents" WHERE "id" = $1`,
      [intentId],
    );
    expect(rows).toHaveLength(1);
    const finalStatus = rows[0].status;
    expect(['cancelled', 'processing']).toContain(finalStatus);

    if (finalStatus === 'cancelled') {
      expect(rows[0].auth_code).toBeNull();
      const ledgerRows = await dataSource.query(
        `SELECT * FROM "ledger_entries" WHERE "payment_intent_id" = $1`,
        [intentId],
      );
      expect(ledgerRows).toHaveLength(0);
    }
  });
});
