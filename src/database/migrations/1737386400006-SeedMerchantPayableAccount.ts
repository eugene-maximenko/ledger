import { MigrationInterface, QueryRunner } from 'typeorm';
import { SEED_MERCHANT_PAYABLE_ACCOUNT_ID } from '../seed-constants';

export class SeedMerchantPayableAccount1737386400006 implements MigrationInterface {
  name = 'SeedMerchantPayableAccount1737386400006';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "accounts" ("id", "type")
       VALUES ($1, 'merchant_payable')
       ON CONFLICT ("id") DO NOTHING`,
      [SEED_MERCHANT_PAYABLE_ACCOUNT_ID],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "accounts" WHERE "id" = $1`, [SEED_MERCHANT_PAYABLE_ACCOUNT_ID]);
  }
}
