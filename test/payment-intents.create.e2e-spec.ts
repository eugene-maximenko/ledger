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
  OTHER_MERCHANT_ID,
  OTHER_MERCHANT_SECRET,
} from './helpers/e2e-test-helpers';

let app: INestApplication | undefined;

beforeAll(async () => {
  app = await setupE2eApp();
});

afterAll(async () => {
  await teardownE2eApp(app);
});

describe('POST /payment-intents (e2e)', () => {
  beforeEach(async () => {
    await truncateTransactionalTables();
    await seedOtherMerchant();
  });

  afterEach(async () => {
    expect(await ledgerSignedSum()).toBe(0);
  });

  it('creates pending PaymentIntent and idempotency row', async () => {
    const res = await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', 'idem-create-1')
      .send({ amount: 1000, currency: 'USD' })
      .expect(201);

    expect(res.body).toMatchObject({
      status: 'pending',
      amount: 1000,
      currency: 'USD',
      merchantId: SEED_ARNE_MERCHANT_ID,
    });
    expect(res.body.id).toBeDefined();
    expect(res.body.createdAt).toBeDefined();

    const intents = await dataSource.query(`SELECT * FROM "payment_intents"`);
    expect(intents).toHaveLength(1);
    const keys = await dataSource.query(`SELECT * FROM "idempotency_keys"`);
    expect(keys).toHaveLength(1);
    expect(keys[0].status).toBe('completed');
    expect(keys[0].merchant_id).toBe(SEED_ARNE_MERCHANT_ID);
  });

  it('returns same body for same Idempotency-Key and does not duplicate rows', async () => {
    const first = await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', 'idem-dup')
      .send({ amount: 500, currency: 'EUR' })
      .expect(201);

    const second = await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', 'idem-dup')
      .send({ amount: 999, currency: 'USD' })
      .expect(201);

    expect(second.body).toEqual(first.body);
    expect(second.body.amount).toBe(500);
    expect(second.body.currency).toBe('EUR');

    const intents = await dataSource.query(`SELECT * FROM "payment_intents"`);
    expect(intents).toHaveLength(1);
  });

  it('allows same key for different merchants', async () => {
    await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', 'shared-key')
      .send({ amount: 100, currency: 'USD' })
      .expect(201);

    const other = await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${OTHER_MERCHANT_SECRET}`)
      .set('Idempotency-Key', 'shared-key')
      .send({ amount: 200, currency: 'USD' })
      .expect(201);

    expect(other.body.merchantId).toBe(OTHER_MERCHANT_ID);
    const intents = await dataSource.query(`SELECT * FROM "payment_intents"`);
    expect(intents).toHaveLength(2);
  });

  it('handles concurrent duplicate idempotency requests with a single intent', async () => {
    const server = app!.getHttpServer();
    const body = { amount: 777, currency: 'USD' };
    const headers = {
      Authorization: `Bearer ${SEED_ARNE_API_SECRET}`,
      'Idempotency-Key': 'idem-race',
      'Content-Type': 'application/json',
    };

    const [a, b] = await Promise.all([
      request(server).post('/payment-intents').set(headers).send(body),
      request(server).post('/payment-intents').set(headers).send(body),
    ]);

    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    expect(a.body.id).toBe(b.body.id);

    const intents = await dataSource.query(`SELECT * FROM "payment_intents"`);
    expect(intents).toHaveLength(1);
  });

  it('401 without Bearer', async () => {
    await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Idempotency-Key', 'x')
      .send({ amount: 1, currency: 'USD' })
      .expect(401);
  });

  it('400 when Idempotency-Key missing or blank', async () => {
    await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .send({ amount: 1, currency: 'USD' })
      .expect(400);

    await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', '   ')
      .send({ amount: 1, currency: 'USD' })
      .expect(400);
  });

  it('400 on invalid body', async () => {
    await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', 'bad-body')
      .send({ amount: 0, currency: 'USD' })
      .expect(400);

    await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', 'bad-currency')
      .send({ amount: 10, currency: 'GBP' })
      .expect(400);
  });
});
