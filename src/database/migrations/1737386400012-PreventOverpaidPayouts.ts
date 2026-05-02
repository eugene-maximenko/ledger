import { MigrationInterface, QueryRunner } from 'typeorm';

export class PreventOverpaidPayouts1737386400012 implements MigrationInterface {
  name = 'PreventOverpaidPayouts1737386400012';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      CREATE OR REPLACE FUNCTION prevent_overpaid_payout()
      RETURNS trigger AS $$
      DECLARE
        gross_amount integer;
        max_payable integer;
        refunded_total integer;
      BEGIN
        IF OLD."status" <> 'pending'::payout_status OR NEW."status" <> 'paid'::payout_status THEN
          RETURN NEW;
        END IF;

        SELECT pi."amount"
        INTO gross_amount
        FROM "payment_intents" pi
        WHERE pi."id" = NEW."payment_intent_id";

        IF gross_amount IS NULL THEN
          RAISE EXCEPTION 'payout payment_intent not found';
        END IF;

        max_payable := gross_amount - ROUND((gross_amount::numeric * 300) / 10000);

        SELECT COALESCE(SUM(r."amount"), 0)::int
        INTO refunded_total
        FROM "refunds" r
        WHERE r."payment_intent_id" = NEW."payment_intent_id"
          AND r."status" = 'succeeded'::refund_status;

        IF NEW."amount" > (max_payable - refunded_total) THEN
          RAISE EXCEPTION 'payout exceeds refundable-adjusted payable amount';
        END IF;

        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql
    `);

    await queryRunner.query(`
      CREATE TRIGGER payouts_overpay_guard_trigger
      BEFORE UPDATE ON "payouts"
      FOR EACH ROW
      EXECUTE FUNCTION prevent_overpaid_payout()
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`
      DROP TRIGGER IF EXISTS payouts_overpay_guard_trigger ON "payouts"
    `);
    await queryRunner.query(`
      DROP FUNCTION IF EXISTS prevent_overpaid_payout
    `);
  }
}
