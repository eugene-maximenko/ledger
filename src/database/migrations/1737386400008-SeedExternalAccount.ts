import { MigrationInterface, QueryRunner } from 'typeorm';
import { SEED_EXTERNAL_ACCOUNT_ID } from '../seed-constants';

export class SeedExternalAccount1737386400008 implements MigrationInterface {
  name = 'SeedExternalAccount1737386400008';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "accounts" ("id", "type")
       VALUES ($1, 'external')
       ON CONFLICT ("id") DO NOTHING`,
      [SEED_EXTERNAL_ACCOUNT_ID],
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DELETE FROM "accounts" WHERE "id" = $1`, [SEED_EXTERNAL_ACCOUNT_ID]);
  }
}
