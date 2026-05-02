import { MigrationInterface, QueryRunner } from 'typeorm';

export class AddCancelledPayoutStatus1737386400014 implements MigrationInterface {
  name = 'AddCancelledPayoutStatus1737386400014';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`ALTER TYPE "payout_status" ADD VALUE 'cancelled'`);
  }

  public async down(): Promise<void> {
    // Postgres enum values are not safely removable in down migration.
  }
}
