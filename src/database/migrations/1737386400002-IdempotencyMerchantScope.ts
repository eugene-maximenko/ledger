import { MigrationInterface, QueryRunner } from 'typeorm';

export class IdempotencyMerchantScope1737386400002 implements MigrationInterface {
  name = 'IdempotencyMerchantScope1737386400002';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TABLE "idempotency_keys" ADD COLUMN "merchant_id" uuid`);
    await queryRunner.query(`
      UPDATE "idempotency_keys"
      SET "merchant_id" = (SELECT "id" FROM "merchants" LIMIT 1)
      WHERE "merchant_id" IS NULL
    `);
    await queryRunner.query(`DELETE FROM "idempotency_keys" WHERE "merchant_id" IS NULL`);
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" ALTER COLUMN "merchant_id" SET NOT NULL`,
    );
    await queryRunner.query(`
      ALTER TABLE "idempotency_keys"
      ADD CONSTRAINT "idempotency_keys_merchant_fk"
      FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id")
    `);
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_key_unique"`,
    );
    await queryRunner.query(`
      ALTER TABLE "idempotency_keys"
      ADD CONSTRAINT "idempotency_keys_merchant_key_unique" UNIQUE ("merchant_id", "key")
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_merchant_key_unique"`,
    );
    await queryRunner.query(
      `ALTER TABLE "idempotency_keys" DROP CONSTRAINT "idempotency_keys_merchant_fk"`,
    );
    await queryRunner.query(`ALTER TABLE "idempotency_keys" DROP COLUMN "merchant_id"`);
    await queryRunner.query(`
      ALTER TABLE "idempotency_keys"
      ADD CONSTRAINT "idempotency_keys_key_unique" UNIQUE ("key")
    `);
  }
}
