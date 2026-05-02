import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddWebhookDeliveryResultColumns1737386400011 implements MigrationInterface {
  name = 'AddWebhookDeliveryResultColumns1737386400011';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "webhook_events" ADD COLUMN "last_http_status" integer`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_events" ADD COLUMN "last_error" text`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_events" ADD COLUMN "last_attempt_at" timestamptz`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "webhook_events" DROP COLUMN "last_attempt_at"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_events" DROP COLUMN "last_error"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_events" DROP COLUMN "last_http_status"`,
    );
  }
}
