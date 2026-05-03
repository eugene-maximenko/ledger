import { INestApplication } from '@nestjs/common';
import request from 'supertest';
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

describe('POST /payment-intents/:id/confirm (e2e)', () => {
  beforeEach(async () => {
    await truncateTransactionalTables();
    await seedOtherMerchant();
  });

  afterEach(async () => {
    expect(await ledgerSignedSum()).toBe(0);
  });

  it('confirms pending intent and stores auth_code', async () => {
    const created = await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', 'idem-confirm-happy')
      .send({ amount: 1000, currency: 'USD' })
      .expect(201);

    const confirmed = await request(app!.getHttpServer())
      .post(`/payment-intents/${created.body.id}/confirm`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ cardToken: 'tok_mock_123' })
      .expect(200);

    expect(confirmed.body).toMatchObject({
      id: created.body.id,
      status: 'processing',
      amount: 1000,
      currency: 'USD',
      merchantId: SEED_ARNE_MERCHANT_ID,
    });
    expect(confirmed.body.authCode).toBeUndefined();
    expect(confirmed.body.auth_code).toBeUndefined();

    const rows = await dataSource.query(
      `SELECT "status", "auth_code" FROM "payment_intents" WHERE "id" = $1`,
      [created.body.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('processing');
    expect(rows[0].auth_code).toEqual(expect.any(String));
  });

  it('401 without Bearer', async () => {
    await request(app!.getHttpServer())
      .post('/payment-intents/00000000-0000-4000-8000-000000000001/confirm')
      .send({ cardToken: 'tok_mock_123' })
      .expect(401);
  });

  it('404 when intent does not exist', async () => {
    await request(app!.getHttpServer())
      .post('/payment-intents/00000000-0000-4000-8000-000000000001/confirm')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ cardToken: 'tok_mock_123' })
      .expect(404);
  });

  it('400 when intent id is not a valid uuid', async () => {
    await request(app!.getHttpServer())
      .post('/payment-intents/d7d5f9ba-b86e-4af3-8b75-13a726346ed/confirm')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ cardToken: 'tok_mock_123' })
      .expect(400);
  });

  it('404 when confirming intent from another merchant', async () => {
    const created = await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', 'idem-confirm-foreign')
      .send({ amount: 800, currency: 'EUR' })
      .expect(201);

    await request(app!.getHttpServer())
      .post(`/payment-intents/${created.body.id}/confirm`)
      .set('Authorization', `Bearer ${OTHER_MERCHANT_SECRET}`)
      .send({ cardToken: 'tok_mock_123' })
      .expect(404);
  });

  it('409 when intent is not pending', async () => {
    const created = await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', 'idem-confirm-wrong-state')
      .send({ amount: 900, currency: 'USD' })
      .expect(201);

    await request(app!.getHttpServer())
      .post(`/payment-intents/${created.body.id}/confirm`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ cardToken: 'tok_mock_123' })
      .expect(200);

    await request(app!.getHttpServer())
      .post(`/payment-intents/${created.body.id}/confirm`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ cardToken: 'tok_mock_123' })
      .expect(409);
  });

  it('400 when confirm body omits cardToken', async () => {
    const created = await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', 'idem-confirm-missing-token')
      .send({ amount: 1000, currency: 'USD' })
      .expect(201);

    await request(app!.getHttpServer())
      .post(`/payment-intents/${created.body.id}/confirm`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({})
      .expect(400);
  });

  it('400 when cardToken is empty string', async () => {
    const created = await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', 'idem-confirm-empty-token')
      .send({ amount: 1000, currency: 'USD' })
      .expect(201);

    await request(app!.getHttpServer())
      .post(`/payment-intents/${created.body.id}/confirm`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ cardToken: '' })
      .expect(400);
  });

  it('400 when cardToken does not match tok_* pattern', async () => {
    const created = await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', 'idem-confirm-bad-token-format')
      .send({ amount: 1000, currency: 'USD' })
      .expect(201);

    await request(app!.getHttpServer())
      .post(`/payment-intents/${created.body.id}/confirm`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ cardToken: 'not_a_tok' })
      .expect(400);
  });

  it('handles concurrent confirm requests: one succeeds, one conflicts', async () => {
    const created = await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', 'idem-confirm-race')
      .send({ amount: 1500, currency: 'USD' })
      .expect(201);

    const server = app!.getHttpServer();
    const headers = {
      Authorization: `Bearer ${SEED_ARNE_API_SECRET}`,
      'Content-Type': 'application/json',
    };
    const body = { cardToken: 'tok_mock_123' };

    const [a, b] = await Promise.all([
      request(server).post(`/payment-intents/${created.body.id}/confirm`).set(headers).send(body),
      request(server).post(`/payment-intents/${created.body.id}/confirm`).set(headers).send(body),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const rows = await dataSource.query(
      `SELECT "status", "auth_code" FROM "payment_intents" WHERE "id" = $1`,
      [created.body.id],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('processing');
    expect(rows[0].auth_code).toEqual(expect.any(String));
  });

  it('marks intent as failed for decline token and does not create ledger/payout', async () => {
    const created = await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', 'idem-confirm-decline')
      .send({ amount: 1000, currency: 'USD' })
      .expect(201);

    const confirmed = await request(app!.getHttpServer())
      .post(`/payment-intents/${created.body.id}/confirm`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ cardToken: 'tok_decline_card_declined' })
      .expect(200);

    expect(confirmed.body).toMatchObject({
      id: created.body.id,
      status: 'failed',
      amount: 1000,
      currency: 'USD',
      merchantId: SEED_ARNE_MERCHANT_ID,
    });
    expect(confirmed.body.authCode).toBeUndefined();
    expect(confirmed.body.auth_code).toBeUndefined();

    const intentRows = await dataSource.query(
      `SELECT "status", "auth_code" FROM "payment_intents" WHERE "id" = $1`,
      [created.body.id],
    );
    expect(intentRows).toHaveLength(1);
    expect(intentRows[0].status).toBe('failed');
    expect(intentRows[0].auth_code).toBeNull();

    const ledgerRows = await dataSource.query(
      `SELECT * FROM "ledger_entries" WHERE "payment_intent_id" = $1`,
      [created.body.id],
    );
    expect(ledgerRows).toHaveLength(0);

    const payouts = await dataSource.query(
      `SELECT * FROM "payouts" WHERE "payment_intent_id" = $1`,
      [created.body.id],
    );
    expect(payouts).toHaveLength(0);
  });
});
