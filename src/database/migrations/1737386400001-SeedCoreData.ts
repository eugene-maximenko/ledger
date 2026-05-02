import { MigrationInterface, QueryRunner } from 'typeorm';
import {
  SEED_ARNE_API_SECRET,
  SEED_ARNE_MERCHANT_ID,
  SEED_ARNE_WEBHOOK_URL,
  SEED_ESCROW_ACCOUNT_ID,
  SEED_REVENUE_ACCOUNT_ID,
} from '../seed-constants';

export class SeedCoreData1737386400001 implements MigrationInterface {
  name = 'SeedCoreData1737386400001';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `
      INSERT INTO "accounts" ("id", "type")
      VALUES ($1, 'escrow'), ($2, 'revenue')
    `,
      [SEED_ESCROW_ACCOUNT_ID, SEED_REVENUE_ACCOUNT_ID],
    );

    await queryRunner.query(
      `
      INSERT INTO "merchants" ("id", "name", "webhook_url", "api_secret", "created_at")
      VALUES ($1, 'Arne', $2, $3, now())
    `,
      [SEED_ARNE_MERCHANT_ID, SEED_ARNE_WEBHOOK_URL, SEED_ARNE_API_SECRET],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "merchants" WHERE "id" = $1`, [SEED_ARNE_MERCHANT_ID]);
    await queryRunner.query(`DELETE FROM "accounts" WHERE "id" IN ($1, $2)`, [
      SEED_ESCROW_ACCOUNT_ID,
      SEED_REVENUE_ACCOUNT_ID,
    ]);
  }
}
