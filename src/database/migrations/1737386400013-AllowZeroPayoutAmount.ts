import { MigrationInterface, QueryRunner } from 'typeorm';

export class AllowZeroPayoutAmount1737386400013 implements MigrationInterface {
  name = 'AllowZeroPayoutAmount1737386400013';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payouts" DROP CONSTRAINT "payouts_amount_positive"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payouts" ADD CONSTRAINT "payouts_amount_non_negative" CHECK ("amount" >= 0)`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "payouts" DROP CONSTRAINT "payouts_amount_non_negative"`,
    );
    await queryRunner.query(
      `ALTER TABLE "payouts" ADD CONSTRAINT "payouts_amount_positive" CHECK ("amount" > 0)`,
    );
  }
}
