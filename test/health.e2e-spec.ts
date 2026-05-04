import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { setupE2eApp, teardownE2eApp } from './helpers/e2e-test-helpers';

let app: INestApplication | undefined;

beforeAll(async () => {
  app = await setupE2eApp();
});

afterAll(async () => {
  await teardownE2eApp(app);
});

describe('GET /health (e2e)', () => {
  it('returns 200 with ok true without Authorization', async () => {
    const res = await request(app!.getHttpServer()).get('/health');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ ok: true });
  });
});
