import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
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

describe('POST /payment-intents/:id/capture (e2e)', () => {
  beforeEach(async () => {
    await truncateTransactionalTables();
    await seedOtherMerchant();
  });

  afterEach(async () => {
    expect(await ledgerSignedSum()).toBe(0);
  });

  async function createProcessingIntent(idemKey: string): Promise<string> {
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

    return created.body.id as string;
  }

  it('captures processing intent and returns succeeded without capture_id', async () => {
    const intentId = await createProcessingIntent('idem-capture-happy');

    const res = await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/capture`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({})
      .expect(200);

    expect(res.body.status).toBe('succeeded');
    expect(res.body.captureId).toBeUndefined();
    expect(res.body.capture_id).toBeUndefined();

    const rows = await dataSource.query(
      `SELECT "status", "capture_id" FROM "payment_intents" WHERE "id" = $1`,
      [intentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('succeeded');
    expect(rows[0].capture_id).toEqual(expect.any(String));
  });

  it('creates payout and 3 ledger entries in one capture', async () => {
    const intentId = await createProcessingIntent('idem-capture-ledger');

    await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/capture`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({})
      .expect(200);

    const ledgerRows = await dataSource.query(
      `SELECT "type", "amount" FROM "ledger_entries" WHERE "payment_intent_id" = $1`,
      [intentId],
    );
    expect(ledgerRows).toHaveLength(3);
    expect(ledgerRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'credit', amount: 1000 }),
        expect.objectContaining({ type: 'debit', amount: 970 }),
        expect.objectContaining({ type: 'debit', amount: 30 }),
      ]),
    );

    const payouts = await dataSource.query(
      `SELECT "status", "amount", "payment_intent_id", "available_at" FROM "payouts" WHERE "payment_intent_id" = $1`,
      [intentId],
    );
    expect(payouts).toHaveLength(1);
    expect(payouts[0].status).toBe('pending');
    expect(payouts[0].payment_intent_id).toBe(intentId);
    // 3% commission from 1000 is 30, merchant payout is 970.
    expect(Number(payouts[0].amount)).toBe(970);
    expect(payouts[0].available_at).toBeDefined();
  });

  it('404 when intent does not exist', async () => {
    await request(app!.getHttpServer())
      .post('/payment-intents/00000000-0000-4000-8000-000000000001/capture')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({})
      .expect(404);
  });

  it('401 without Bearer', async () => {
    const intentId = await createProcessingIntent('idem-capture-no-bearer');

    await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/capture`)
      .send({})
      .expect(401);
  });

  it('404 when capturing intent from another merchant', async () => {
    const intentId = await createProcessingIntent('idem-capture-foreign');

    await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/capture`)
      .set('Authorization', `Bearer ${OTHER_MERCHANT_SECRET}`)
      .send({})
      .expect(404);
  });

  it('409 when intent is not processing', async () => {
    const created = await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', 'idem-capture-wrong-state')
      .send({ amount: 1000, currency: 'USD' })
      .expect(201);

    await request(app!.getHttpServer())
      .post(`/payment-intents/${created.body.id}/capture`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({})
      .expect(409);
  });

  it('400 when intent id is not a valid uuid', async () => {
    await request(app!.getHttpServer())
      .post('/payment-intents/d7d5f9ba-b86e-4af3-8b75-13a726346ed/capture')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({})
      .expect(400);
  });

  it('400 when body is not empty (explicit empty DTO contract)', async () => {
    const intentId = await createProcessingIntent('idem-capture-body');

    await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/capture`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ unexpected: 'field' })
      .expect(400);
  });

  it('second capture call conflicts and does not duplicate side effects', async () => {
    const intentId = await createProcessingIntent('idem-capture-double');

    await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/capture`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({})
      .expect(200);

    await request(app!.getHttpServer())
      .post(`/payment-intents/${intentId}/capture`)
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({})
      .expect(409);

    const ledgerRows = await dataSource.query(
      `SELECT * FROM "ledger_entries" WHERE "payment_intent_id" = $1`,
      [intentId],
    );
    expect(ledgerRows).toHaveLength(3);

    const payouts = await dataSource.query(
      `SELECT * FROM "payouts" WHERE "payment_intent_id" = $1`,
      [intentId],
    );
    expect(payouts).toHaveLength(1);
  });

  it('handles concurrent capture requests: one succeeds, one conflicts', async () => {
    const intentId = await createProcessingIntent('idem-capture-race');
    const server = app!.getHttpServer();
    const headers = {
      Authorization: `Bearer ${SEED_ARNE_API_SECRET}`,
      'Content-Type': 'application/json',
    };

    const [a, b] = await Promise.all([
      request(server).post(`/payment-intents/${intentId}/capture`).set(headers).send({}),
      request(server).post(`/payment-intents/${intentId}/capture`).set(headers).send({}),
    ]);

    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 409]);

    const ledgerRows = await dataSource.query(
      `SELECT * FROM "ledger_entries" WHERE "payment_intent_id" = $1`,
      [intentId],
    );
    expect(ledgerRows).toHaveLength(3);

    const payouts = await dataSource.query(
      `SELECT * FROM "payouts" WHERE "payment_intent_id" = $1`,
      [intentId],
    );
    expect(payouts).toHaveLength(1);
  });
});
