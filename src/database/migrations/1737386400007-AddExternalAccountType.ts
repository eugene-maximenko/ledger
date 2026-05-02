import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddExternalAccountType1737386400007 implements MigrationInterface {
  name = 'AddExternalAccountType1737386400007';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      ALTER TYPE "account_type" ADD VALUE IF NOT EXISTS 'external'
    `);
  }

  public async down(_queryRunner: QueryRunner): Promise<void> {}
}
