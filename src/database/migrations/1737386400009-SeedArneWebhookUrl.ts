import { MigrationInterface, QueryRunner } from 'typeorm';
import { SEED_ARNE_MERCHANT_ID, SEED_ARNE_WEBHOOK_URL } from '../seed-constants';

export class SeedArneWebhookUrl1737386400009 implements MigrationInterface {
  name = 'SeedArneWebhookUrl1737386400009';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "merchants"
       SET "webhook_url" = $1
       WHERE "id" = $2`,
      [SEED_ARNE_WEBHOOK_URL, SEED_ARNE_MERCHANT_ID],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `UPDATE "merchants"
       SET "webhook_url" = NULL
       WHERE "id" = $1`,
      [SEED_ARNE_MERCHANT_ID],
    );
  }
}
