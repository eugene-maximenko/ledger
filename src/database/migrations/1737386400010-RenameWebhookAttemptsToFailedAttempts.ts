import { MigrationInterface, QueryRunner } from 'typeorm';

export class RenameWebhookAttemptsToFailedAttempts1737386400010 implements MigrationInterface {
  name = 'RenameWebhookAttemptsToFailedAttempts1737386400010';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "webhook_events" RENAME COLUMN "attempts" TO "failed_attempts"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_attempts_non_negative"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_events"
       ADD CONSTRAINT "webhook_events_failed_attempts_non_negative" CHECK ("failed_attempts" >= 0)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "webhook_events" DROP CONSTRAINT "webhook_events_failed_attempts_non_negative"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_events" RENAME COLUMN "failed_attempts" TO "attempts"`,
    );
    await queryRunner.query(
      `ALTER TABLE "webhook_events"
       ADD CONSTRAINT "webhook_events_attempts_non_negative" CHECK ("attempts" >= 0)`,
    );
  }
}
