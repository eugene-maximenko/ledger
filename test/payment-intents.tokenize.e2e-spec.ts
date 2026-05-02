import { INestApplication } from '@nestjs/common';
import * as request from 'supertest';
import { ledgerSignedSum, setupE2eApp, teardownE2eApp, truncateTransactionalTables } from './helpers/e2e-test-helpers';

let app: INestApplication | undefined;

beforeAll(async () => {
  app = await setupE2eApp();
});

afterAll(async () => {
  await teardownE2eApp(app);
});

describe('POST /tokenize (e2e)', () => {
  beforeEach(async () => {
    await truncateTransactionalTables();
  });

  afterEach(async () => {
    expect(await ledgerSignedSum()).toBe(0);
  });

  it('returns cardToken for valid card payload', async () => {
    const res = await request(app!.getHttpServer())
      .post('/tokenize')
      .send({
        cardNumber: '4242424242424242',
        expiry: '12/30',
        cvv: '123',
      })
      .expect(201);

    expect(res.body).toEqual({
      cardToken: expect.stringMatching(/^tok_/),
    });
  });

  it('returns 201 without Authorization header', async () => {
    await request(app!.getHttpServer())
      .post('/tokenize')
      .send({
        cardNumber: '4242424242424242',
        expiry: '12/30',
        cvv: '123',
      })
      .expect(201);
  });

  it('400 when cardNumber is invalid', async () => {
    await request(app!.getHttpServer())
      .post('/tokenize')
      .send({
        cardNumber: '4242abcd',
        expiry: '12/30',
        cvv: '123',
      })
      .expect(400);

    await request(app!.getHttpServer())
      .post('/tokenize')
      .send({
        cardNumber: '123',
        expiry: '12/30',
        cvv: '123',
      })
      .expect(400);

    await request(app!.getHttpServer())
      .post('/tokenize')
      .send({
        cardNumber: '12345678901234567890',
        expiry: '12/30',
        cvv: '123',
      })
      .expect(400);
  });

  it('400 when expiry is invalid', async () => {
    await request(app!.getHttpServer())
      .post('/tokenize')
      .send({
        cardNumber: '4242424242424242',
        expiry: '1/30',
        cvv: '123',
      })
      .expect(400);

    await request(app!.getHttpServer())
      .post('/tokenize')
      .send({
        cardNumber: '4242424242424242',
        expiry: '00/30',
        cvv: '123',
      })
      .expect(400);

    await request(app!.getHttpServer())
      .post('/tokenize')
      .send({
        cardNumber: '4242424242424242',
        expiry: '13/30',
        cvv: '123',
      })
      .expect(400);
  });

  it('400 when cvv is invalid', async () => {
    await request(app!.getHttpServer())
      .post('/tokenize')
      .send({
        cardNumber: '4242424242424242',
        expiry: '12/30',
        cvv: '12',
      })
      .expect(400);

    await request(app!.getHttpServer())
      .post('/tokenize')
      .send({
        cardNumber: '4242424242424242',
        expiry: '12/30',
        cvv: '12a',
      })
      .expect(400);
  });

  it('400 when required fields are missing', async () => {
    await request(app!.getHttpServer())
      .post('/tokenize')
      .send({
        expiry: '12/30',
        cvv: '123',
      })
      .expect(400);

    await request(app!.getHttpServer())
      .post('/tokenize')
      .send({
        cardNumber: '4242424242424242',
        cvv: '123',
      })
      .expect(400);

    await request(app!.getHttpServer())
      .post('/tokenize')
      .send({
        cardNumber: '4242424242424242',
        expiry: '12/30',
      })
      .expect(400);
  });

  it('returns only cardToken in response body', async () => {
    const res = await request(app!.getHttpServer())
      .post('/tokenize')
      .send({
        cardNumber: '4242424242424242',
        expiry: '12/30',
        cvv: '123',
      })
      .expect(201);

    expect(res.body).toEqual({
      cardToken: expect.any(String),
    });
    expect(res.body.cardNumber).toBeUndefined();
    expect(res.body.expiry).toBeUndefined();
    expect(res.body.cvv).toBeUndefined();
  });

  it('returns deterministic decline token for special test card', async () => {
    const res = await request(app!.getHttpServer())
      .post('/tokenize')
      .send({
        cardNumber: '4000000000000002',
        expiry: '12/30',
        cvv: '123',
      })
      .expect(201);

    expect(res.body).toEqual({
      cardToken: 'tok_decline_card_declined',
    });
  });
});
