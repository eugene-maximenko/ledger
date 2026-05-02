import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddMerchantPayableAccount1737386400005 implements MigrationInterface {
  name = 'AddMerchantPayableAccount1737386400005';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "account_type" ADD VALUE IF NOT EXISTS 'merchant_payable'
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
