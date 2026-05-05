import { INestApplication, ValidationPipe } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { AppModule } from '../../src/app.module';
import dataSource from '../../src/database/data-source';

export const OTHER_MERCHANT_ID = 'c0000001-0000-4000-8000-000000000001';
export const OTHER_MERCHANT_SECRET = 'dev_other_sk_test_01';

export async function setupE2eApp(): Promise<INestApplication> {
  if (!dataSource.isInitialized) {
    await dataSource.initialize();
  }
  await dataSource.runMigrations({ transaction: 'each' });

  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  const app = moduleFixture.createNestApplication({ logger: false });
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );
  await app.init();

  return app;
}

export async function teardownE2eApp(app: INestApplication | undefined): Promise<void> {
  if (app) {
    await app.close();
  }
  if (dataSource.isInitialized) {
    await dataSource.destroy();
  }
}

export async function truncateTransactionalTables(): Promise<void> {
  await dataSource.query(
    `TRUNCATE TABLE
      "webhook_events",
      "ledger_entries",
      "payouts",
      "refunds",
      "payment_intents",
      "idempotency_keys"
    RESTART IDENTITY CASCADE`,
  );
  await dataSource.query(`ALTER SEQUENCE "ledger_entry_sequence_seq" RESTART WITH 1`);
}

export async function ledgerSignedSum(): Promise<number> {
  const rows = (await dataSource.query(
    `SELECT COALESCE(SUM(CASE WHEN "type" = 'debit' THEN "amount" WHEN "type" = 'credit' THEN -"amount" ELSE 0 END), 0)::text AS s
     FROM "ledger_entries"`,
  )) as { s: string }[];
  return Number(rows[0]?.s ?? 0);
}

export async function seedOtherMerchant(): Promise<void> {
  await dataSource.query(`DELETE FROM "merchants" WHERE "id" = $1`, [OTHER_MERCHANT_ID]);
  await dataSource.query(
    `INSERT INTO "merchants" ("id", "name", "webhook_url", "api_secret", "created_at")
     VALUES ($1, 'Other', NULL, $2, NOW())`,
    [OTHER_MERCHANT_ID, OTHER_MERCHANT_SECRET],
  );
}
