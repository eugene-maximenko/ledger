import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddAuthCodeToPaymentIntents1737386400003 implements MigrationInterface {
  name = 'AddAuthCodeToPaymentIntents1737386400003';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payment_intents" ADD COLUMN "auth_code" varchar`);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "payment_intents" DROP COLUMN "auth_code"`);
  }
}
