import { MigrationInterface, QueryRunner } from 'typeorm';

export class MakeLedgerEntriesImmutable1737386400004 implements MigrationInterface {
  name = 'MakeLedgerEntriesImmutable1737386400004';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION prevent_ledger_entries_mutation()
      RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'ledger_entries are immutable';
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER ledger_entries_immutable_trigger
      BEFORE UPDATE OR DELETE ON "ledger_entries"
      FOR EACH ROW
      EXECUTE FUNCTION prevent_ledger_entries_mutation()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS ledger_entries_immutable_trigger ON "ledger_entries"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS prevent_ledger_entries_mutation
    `);
  }
}
