import { INestApplication } from '@nestjs/common';
import { createHmac } from 'crypto';
import * as http from 'http';
import { AddressInfo } from 'net';
import { randomUUID } from 'crypto';
import request from 'supertest';
import dataSource from '../src/database/data-source';
import { WebhookEventStatus } from '../src/database/db.enums';
import {
  SEED_ARNE_API_SECRET,
  SEED_ARNE_MERCHANT_ID,
  SEED_WEBHOOK_HMAC_SECRET,
} from '../src/database/seed-constants';
import {
  setupE2eApp,
  teardownE2eApp,
  truncateTransactionalTables,
} from './helpers/e2e-test-helpers';

let app: INestApplication | undefined;
let receiverServer: http.Server | undefined;
let receiverUrl = '';
let receiverStatusCode = 200;
let receiverCalls = 0;
let lastBody: unknown = null;
let lastHeaders: Record<string, string | string[] | undefined> = {};
let receiverVerifySignature = false;
const TEST_WEBHOOK_SECRET = SEED_WEBHOOK_HMAC_SECRET;
let receiverSecret = TEST_WEBHOOK_SECRET;
let receiverRejectOldTimestamp = false;
let receiverMaxSkewMs = 5 * 60 * 1000;
let receiverTamperBeforeVerify = false;
let receiverNowMsOverride: number | null = null;

beforeAll(async () => {
  app = await setupE2eApp();
  receiverServer = http.createServer((req, res) => {
    if (req.method !== 'POST') {
      res.statusCode = 405;
      res.end();
      return;
    }

    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk.toString();
    });
    req.on('end', () => {
      receiverCalls += 1;
      lastHeaders = req.headers;

      let responseCode = receiverStatusCode;
      if (receiverVerifySignature) {
        const timestamp = req.headers['x-webhook-timestamp'];
        const signature = req.headers['x-webhook-signature'];
        const timestampValue = Array.isArray(timestamp) ? timestamp[0] : timestamp;
        const signatureValue = Array.isArray(signature) ? signature[0] : signature;

        if (!timestampValue || !signatureValue) {
          responseCode = 400;
        } else if (
          receiverRejectOldTimestamp &&
          Math.abs((receiverNowMsOverride ?? Date.now()) - Number(timestampValue)) > receiverMaxSkewMs
        ) {
          responseCode = 400;
        } else {
          const bodyForVerify = receiverTamperBeforeVerify ? `${raw}tampered` : raw;
          const expected = createHmac('sha256', receiverSecret)
            .update(`${timestampValue}.${bodyForVerify}`)
            .digest('hex');
          if (expected !== signatureValue) {
            responseCode = 400;
          }
        }
      }

      try {
        lastBody = raw ? JSON.parse(raw) : null;
      } catch {
        lastBody = raw;
      }
      res.statusCode = responseCode;
      res.end('ok');
    });
  });

  await new Promise<void>((resolve) => {
    receiverServer!.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = receiverServer.address() as AddressInfo;
  receiverUrl = `http://127.0.0.1:${addr.port}/webhook`;
});

afterAll(async () => {
  if (receiverServer) {
    await new Promise<void>((resolve, reject) => {
      receiverServer!.close((err) => (err ? reject(err) : resolve()));
    });
  }
  await teardownE2eApp(app);
});

describe('Webhook delivery worker (e2e)', () => {
  beforeEach(async () => {
    await truncateTransactionalTables();
    receiverStatusCode = 200;
    receiverCalls = 0;
    lastBody = null;
    lastHeaders = {};
    receiverVerifySignature = false;
    receiverSecret = TEST_WEBHOOK_SECRET;
    receiverRejectOldTimestamp = false;
    receiverMaxSkewMs = 5 * 60 * 1000;
    receiverTamperBeforeVerify = false;
    receiverNowMsOverride = null;
    await dataSource.query(
      `UPDATE "merchants" SET "webhook_url" = $1 WHERE "id" = $2`,
      [receiverUrl, SEED_ARNE_MERCHANT_ID],
    );
  });

  async function createPendingIntent(): Promise<string> {
    const created = await request(app!.getHttpServer())
      .post('/payment-intents')
      .set('Authorization', `Bearer ${SEED_ARNE_API_SECRET}`)
      .set('Idempotency-Key', `idem-webhook-delivery-${randomUUID()}`)
      .send({ amount: 1000, currency: 'USD' })
      .expect(201);
    return created.body.id as string;
  }

  async function insertPendingWebhookEvent(paymentIntentId: string, failedAttempts = 0): Promise<string> {
    const rows = (await dataSource.query(
      `INSERT INTO "webhook_events" (
         "id", "event_type", "payload", "status", "failed_attempts", "next_retry_at", "payment_intent_id", "created_at", "updated_at"
       )
       VALUES (gen_random_uuid(), $1, $2::jsonb, $3, $4, NULL, $5, NOW(), NOW())
       RETURNING "id"`,
      [
        'payment.succeeded',
        JSON.stringify({ type: 'payment.succeeded', data: { id: paymentIntentId } }),
        WebhookEventStatus.Pending,
        failedAttempts,
        paymentIntentId,
      ],
    )) as { id: string }[];

    return rows[0].id;
  }

  function expectRetryDelayApprox(nextRetryAt: string, expectedMinutes: number): void {
    const msLeft = new Date(nextRetryAt).getTime() - Date.now();
    const expectedMs = expectedMinutes * 60 * 1000;
    expect(msLeft).toBeGreaterThanOrEqual(expectedMs - 10_000);
    expect(msLeft).toBeLessThanOrEqual(expectedMs + 20_000);
  }

  it('delivers pending webhook and marks event delivered', async () => {
    const intentId = await createPendingIntent();
    const eventId = await insertPendingWebhookEvent(intentId, 0);

    await request(app!.getHttpServer())
      .post('/internal/workers/webhook-delivery/tick')
      .expect(200);

    expect(receiverCalls).toBe(1);
    expect(lastBody).toEqual(expect.objectContaining({ type: 'payment.succeeded' }));

    const rows = await dataSource.query(
      `SELECT "status", "failed_attempts", "next_retry_at", "last_http_status", "last_error", "last_attempt_at"
       FROM "webhook_events"
       WHERE "id" = $1`,
      [eventId],
    );
    expect(rows[0].status).toBe('delivered');
    expect(Number(rows[0].failed_attempts)).toBe(0);
    expect(rows[0].next_retry_at).toBeNull();
    expect(Number(rows[0].last_http_status)).toBe(200);
    expect(rows[0].last_error).toBeNull();
    expect(rows[0].last_attempt_at).not.toBeNull();
  });

  it('increments failed_attempts and schedules retry on non-2xx', async () => {
    receiverStatusCode = 500;
    const intentId = await createPendingIntent();
    const eventId = await insertPendingWebhookEvent(intentId, 0);

    await request(app!.getHttpServer())
      .post('/internal/workers/webhook-delivery/tick')
      .expect(200);

    expect(receiverCalls).toBe(1);
    const rows = await dataSource.query(
      `SELECT "status", "failed_attempts", "next_retry_at", "last_http_status", "last_error", "last_attempt_at"
       FROM "webhook_events"
       WHERE "id" = $1`,
      [eventId],
    );
    expect(rows[0].status).toBe('pending');
    expect(Number(rows[0].failed_attempts)).toBe(1);
    expect(rows[0].next_retry_at).not.toBeNull();
    expect(Number(rows[0].last_http_status)).toBe(500);
    expect(rows[0].last_error).toBeNull();
    expect(rows[0].last_attempt_at).not.toBeNull();
    expectRetryDelayApprox(rows[0].next_retry_at as string, 1);
  });

  it('uses exponential backoff schedule per failed attempt', async () => {
    receiverStatusCode = 500;
    const expected: Array<{ failedAttemptsBefore: number; delayMinutes: number }> = [
      { failedAttemptsBefore: 0, delayMinutes: 1 },
      { failedAttemptsBefore: 1, delayMinutes: 5 },
      { failedAttemptsBefore: 2, delayMinutes: 30 },
      { failedAttemptsBefore: 3, delayMinutes: 120 },
      { failedAttemptsBefore: 4, delayMinutes: 480 },
    ];

    for (const c of expected) {
      await truncateTransactionalTables();
      receiverCalls = 0;
      const intentId = await createPendingIntent();
      const eventId = await insertPendingWebhookEvent(intentId, c.failedAttemptsBefore);

      await request(app!.getHttpServer())
        .post('/internal/workers/webhook-delivery/tick')
        .expect(200);

      const rows = await dataSource.query(
        `SELECT "status", "failed_attempts", "next_retry_at", "last_http_status", "last_error", "last_attempt_at"
         FROM "webhook_events"
         WHERE "id" = $1`,
        [eventId],
      );

      if (c.failedAttemptsBefore === 4) {
        expect(rows[0].status).toBe('failed');
        expect(Number(rows[0].failed_attempts)).toBe(5);
        expect(rows[0].next_retry_at).toBeNull();
        expect(Number(rows[0].last_http_status)).toBe(500);
        expect(rows[0].last_attempt_at).not.toBeNull();
      } else {
        expect(rows[0].status).toBe('pending');
        expect(Number(rows[0].failed_attempts)).toBe(c.failedAttemptsBefore + 1);
        expect(rows[0].next_retry_at).not.toBeNull();
        expect(Number(rows[0].last_http_status)).toBe(500);
        expect(rows[0].last_attempt_at).not.toBeNull();
        expectRetryDelayApprox(rows[0].next_retry_at as string, c.delayMinutes);
      }
    }
  });

  it('does not process events whose next_retry_at is in the future', async () => {
    const intentId = await createPendingIntent();
    const eventId = await insertPendingWebhookEvent(intentId, 0);
    await dataSource.query(
      `UPDATE "webhook_events" SET "next_retry_at" = NOW() + INTERVAL '10 minutes' WHERE "id" = $1`,
      [eventId],
    );

    await request(app!.getHttpServer())
      .post('/internal/workers/webhook-delivery/tick')
      .expect(200);

    expect(receiverCalls).toBe(0);
    const rows = await dataSource.query(
      `SELECT "status", "failed_attempts" FROM "webhook_events" WHERE "id" = $1`,
      [eventId],
    );
    expect(rows[0].status).toBe('pending');
    expect(Number(rows[0].failed_attempts)).toBe(0);
  });

  it('marks event failed after max retry failed_attempts', async () => {
    receiverStatusCode = 500;
    const intentId = await createPendingIntent();
    const eventId = await insertPendingWebhookEvent(intentId, 4);

    await request(app!.getHttpServer())
      .post('/internal/workers/webhook-delivery/tick')
      .expect(200);

    expect(receiverCalls).toBe(1);
    const rows = await dataSource.query(
      `SELECT "status", "failed_attempts", "next_retry_at", "last_http_status", "last_error", "last_attempt_at"
       FROM "webhook_events"
       WHERE "id" = $1`,
      [eventId],
    );
    expect(rows[0].status).toBe('failed');
    expect(Number(rows[0].failed_attempts)).toBe(5);
    expect(rows[0].next_retry_at).toBeNull();
    expect(Number(rows[0].last_http_status)).toBe(500);
    expect(rows[0].last_attempt_at).not.toBeNull();
  });

  it('is safe under concurrent delivery ticks', async () => {
    const intentId = await createPendingIntent();
    const eventId = await insertPendingWebhookEvent(intentId, 0);

    const server = app!.getHttpServer();
    const [a, b] = await Promise.all([
      request(server).post('/internal/workers/webhook-delivery/tick'),
      request(server).post('/internal/workers/webhook-delivery/tick'),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses).toEqual([200, 200]);

    expect(receiverCalls).toBe(1);
    const rows = await dataSource.query(
      `SELECT "status", "failed_attempts" FROM "webhook_events" WHERE "id" = $1`,
      [eventId],
    );
    expect(rows[0].status).toBe('delivered');
    expect(Number(rows[0].failed_attempts)).toBe(0);
  });

  it('handles merchant webhook_url = null without crashing', async () => {
    await dataSource.query(
      `UPDATE "merchants" SET "webhook_url" = NULL WHERE "id" = $1`,
      [SEED_ARNE_MERCHANT_ID],
    );
    const intentId = await createPendingIntent();
    const eventId = await insertPendingWebhookEvent(intentId, 0);

    await request(app!.getHttpServer())
      .post('/internal/workers/webhook-delivery/tick')
      .expect(200);

    expect(receiverCalls).toBe(0);
    const rows = await dataSource.query(
      `SELECT "status", "failed_attempts", "next_retry_at", "last_http_status", "last_error", "last_attempt_at"
       FROM "webhook_events"
       WHERE "id" = $1`,
      [eventId],
    );
    expect(rows[0].status).toBe('failed');
    expect(Number(rows[0].failed_attempts)).toBe(0);
    expect(rows[0].next_retry_at).toBeNull();
    expect(rows[0].last_http_status).toBeNull();
    expect(rows[0].last_error).toMatch(/webhook_url/i);
    expect(rows[0].last_attempt_at).not.toBeNull();
  });

  it('sends HMAC headers and succeeds when signature is valid', async () => {
    receiverVerifySignature = true;
    const intentId = await createPendingIntent();
    const eventId = await insertPendingWebhookEvent(intentId, 0);

    await request(app!.getHttpServer())
      .post('/internal/workers/webhook-delivery/tick')
      .expect(200);

    expect(receiverCalls).toBe(1);
    expect(lastHeaders['x-webhook-timestamp']).toBeDefined();
    expect(lastHeaders['x-webhook-signature']).toBeDefined();
    const timestampHeader = Array.isArray(lastHeaders['x-webhook-timestamp'])
      ? lastHeaders['x-webhook-timestamp'][0]
      : lastHeaders['x-webhook-timestamp'];
    expect(timestampHeader).toMatch(/^\d+$/);
    const ts = Number(timestampHeader);
    expect(Math.abs(Date.now() - ts)).toBeLessThanOrEqual(10_000);
    const rows = await dataSource.query(
      `SELECT "status", "failed_attempts", "last_http_status", "last_error", "last_attempt_at"
       FROM "webhook_events"
       WHERE "id" = $1`,
      [eventId],
    );
    expect(rows[0].status).toBe('delivered');
    expect(Number(rows[0].failed_attempts)).toBe(0);
    expect(Number(rows[0].last_http_status)).toBe(200);
    expect(rows[0].last_error).toBeNull();
    expect(rows[0].last_attempt_at).not.toBeNull();
  });

  it('retries when signature verification fails on tampered body', async () => {
    receiverVerifySignature = true;
    receiverTamperBeforeVerify = true;
    const intentId = await createPendingIntent();
    const eventId = await insertPendingWebhookEvent(intentId, 0);

    await request(app!.getHttpServer())
      .post('/internal/workers/webhook-delivery/tick')
      .expect(200);

    const rows = await dataSource.query(
      `SELECT "status", "failed_attempts", "next_retry_at", "last_http_status", "last_error", "last_attempt_at"
       FROM "webhook_events"
       WHERE "id" = $1`,
      [eventId],
    );
    expect(rows[0].status).toBe('pending');
    expect(Number(rows[0].failed_attempts)).toBe(1);
    expect(rows[0].next_retry_at).not.toBeNull();
    expect(Number(rows[0].last_http_status)).toBe(400);
    expect(rows[0].last_attempt_at).not.toBeNull();
  });

  it('retries when receiver uses wrong webhook secret', async () => {
    receiverVerifySignature = true;
    receiverSecret = 'wrong_secret';
    const intentId = await createPendingIntent();
    const eventId = await insertPendingWebhookEvent(intentId, 0);

    await request(app!.getHttpServer())
      .post('/internal/workers/webhook-delivery/tick')
      .expect(200);

    const rows = await dataSource.query(
      `SELECT "status", "failed_attempts", "next_retry_at", "last_http_status", "last_error", "last_attempt_at"
       FROM "webhook_events"
       WHERE "id" = $1`,
      [eventId],
    );
    expect(rows[0].status).toBe('pending');
    expect(Number(rows[0].failed_attempts)).toBe(1);
    expect(rows[0].next_retry_at).not.toBeNull();
    expect(Number(rows[0].last_http_status)).toBe(400);
    expect(rows[0].last_attempt_at).not.toBeNull();
  });

  it('retries when receiver rejects old webhook timestamp', async () => {
    receiverVerifySignature = true;
    receiverRejectOldTimestamp = true;
    receiverMaxSkewMs = 60_000;
    receiverNowMsOverride = Date.now() + 10 * 60 * 1000;
    const intentId = await createPendingIntent();
    const eventId = await insertPendingWebhookEvent(intentId, 0);

    await request(app!.getHttpServer())
      .post('/internal/workers/webhook-delivery/tick')
      .expect(200);

    const rows = await dataSource.query(
      `SELECT "status", "failed_attempts", "next_retry_at", "last_http_status", "last_error", "last_attempt_at"
       FROM "webhook_events"
       WHERE "id" = $1`,
      [eventId],
    );
    expect(rows[0].status).toBe('pending');
    expect(Number(rows[0].failed_attempts)).toBe(1);
    expect(rows[0].next_retry_at).not.toBeNull();
    expect(Number(rows[0].last_http_status)).toBe(400);
    expect(rows[0].last_attempt_at).not.toBeNull();
  });

  it('delivers on next retry when signature passes after first failure', async () => {
    receiverVerifySignature = true;
    receiverSecret = 'wrong_secret';
    const intentId = await createPendingIntent();
    const eventId = await insertPendingWebhookEvent(intentId, 0);

    await request(app!.getHttpServer())
      .post('/internal/workers/webhook-delivery/tick')
      .expect(200);

    receiverSecret = TEST_WEBHOOK_SECRET;
    await dataSource.query(
      `UPDATE "webhook_events" SET "next_retry_at" = NOW() - INTERVAL '1 second' WHERE "id" = $1`,
      [eventId],
    );

    await request(app!.getHttpServer())
      .post('/internal/workers/webhook-delivery/tick')
      .expect(200);

    const rows = await dataSource.query(
      `SELECT "status", "failed_attempts", "next_retry_at", "last_http_status", "last_error", "last_attempt_at"
       FROM "webhook_events"
       WHERE "id" = $1`,
      [eventId],
    );
    expect(rows[0].status).toBe('delivered');
    expect(Number(rows[0].failed_attempts)).toBe(1);
    expect(rows[0].next_retry_at).toBeNull();
    expect(Number(rows[0].last_http_status)).toBe(200);
    expect(rows[0].last_error).toBeNull();
    expect(rows[0].last_attempt_at).not.toBeNull();
  });
});
