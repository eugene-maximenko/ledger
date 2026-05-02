import { MigrationInterface, QueryRunner } from 'typeorm';

export class InitialSchema1737386400000 implements MigrationInterface {
  name = 'InitialSchema1737386400000';

  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`CREATE EXTENSION IF NOT EXISTS "pgcrypto"`);

    await queryRunner.query(
      `CREATE TYPE "payment_intent_status" AS ENUM ('pending', 'processing', 'succeeded', 'failed', 'cancelled')`,
    );
    await queryRunner.query(
      `CREATE TYPE "idempotency_key_status" AS ENUM ('processing', 'completed')`,
    );
    await queryRunner.query(`CREATE TYPE "account_type" AS ENUM ('escrow', 'revenue')`);
    await queryRunner.query(`CREATE TYPE "ledger_entry_type" AS ENUM ('debit', 'credit')`);
    await queryRunner.query(`CREATE TYPE "payout_status" AS ENUM ('pending', 'paid')`);
    await queryRunner.query(
      `CREATE TYPE "refund_status" AS ENUM ('pending', 'succeeded', 'failed')`,
    );
    await queryRunner.query(
      `CREATE TYPE "webhook_event_status" AS ENUM ('pending', 'delivered', 'failed')`,
    );

    await queryRunner.query(`
      CREATE TABLE "merchants" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "name" varchar NOT NULL,
        "webhook_url" varchar,
        "api_secret" varchar NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "merchants_api_secret_unique" UNIQUE ("api_secret")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "accounts" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "type" "account_type" NOT NULL,
        CONSTRAINT "accounts_type_unique" UNIQUE ("type")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "idempotency_keys" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "key" varchar NOT NULL,
        "status" "idempotency_key_status" NOT NULL,
        "result" jsonb,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "expires_at" timestamptz NOT NULL,
        CONSTRAINT "idempotency_keys_key_unique" UNIQUE ("key")
      )
    `);

    await queryRunner.query(`CREATE SEQUENCE "ledger_entry_sequence_seq"`);

    await queryRunner.query(`
      CREATE TABLE "payment_intents" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "status" "payment_intent_status" NOT NULL,
        "amount" integer NOT NULL,
        "currency" varchar(3) NOT NULL,
        "capture_id" varchar,
        "merchant_id" uuid NOT NULL,
        "idempotency_key_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "payment_intents_amount_positive" CHECK ("amount" > 0),
        CONSTRAINT "payment_intents_currency_allowed" CHECK ("currency" IN ('USD', 'EUR')),
        CONSTRAINT "payment_intents_succeeded_requires_capture" CHECK (
          "status" <> 'succeeded'::payment_intent_status OR "capture_id" IS NOT NULL
        ),
        CONSTRAINT "payment_intents_merchant_fk" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id"),
        CONSTRAINT "payment_intents_idempotency_fk" FOREIGN KEY ("idempotency_key_id") REFERENCES "idempotency_keys"("id"),
        CONSTRAINT "payment_intents_idempotency_unique" UNIQUE ("idempotency_key_id")
      )
    `);

    await queryRunner.query(`
      CREATE UNIQUE INDEX "payment_intents_capture_id_unique"
      ON "payment_intents" ("capture_id")
      WHERE "capture_id" IS NOT NULL
    `);

    await queryRunner.query(`
      CREATE TABLE "refunds" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "status" "refund_status" NOT NULL,
        "amount" integer NOT NULL,
        "payment_intent_id" uuid NOT NULL,
        "idempotency_key_id" uuid NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "refunds_amount_positive" CHECK ("amount" > 0),
        CONSTRAINT "refunds_payment_intent_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents"("id"),
        CONSTRAINT "refunds_idempotency_fk" FOREIGN KEY ("idempotency_key_id") REFERENCES "idempotency_keys"("id"),
        CONSTRAINT "refunds_idempotency_unique" UNIQUE ("idempotency_key_id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "payouts" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "status" "payout_status" NOT NULL,
        "amount" integer NOT NULL,
        "merchant_id" uuid NOT NULL,
        "payment_intent_id" uuid NOT NULL,
        "available_at" timestamptz NOT NULL,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "payouts_amount_positive" CHECK ("amount" > 0),
        CONSTRAINT "payouts_merchant_fk" FOREIGN KEY ("merchant_id") REFERENCES "merchants"("id"),
        CONSTRAINT "payouts_payment_intent_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents"("id"),
        CONSTRAINT "payouts_payment_intent_unique" UNIQUE ("payment_intent_id")
      )
    `);

    await queryRunner.query(`
      CREATE TABLE "ledger_entries" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "account_id" uuid NOT NULL,
        "type" "ledger_entry_type" NOT NULL,
        "amount" integer NOT NULL,
        "sequence_number" bigint NOT NULL DEFAULT nextval('ledger_entry_sequence_seq'),
        "payment_intent_id" uuid,
        "refund_id" uuid,
        "payout_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "ledger_entries_amount_positive" CHECK ("amount" > 0),
        CONSTRAINT "ledger_entries_account_fk" FOREIGN KEY ("account_id") REFERENCES "accounts"("id"),
        CONSTRAINT "ledger_entries_payment_intent_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents"("id"),
        CONSTRAINT "ledger_entries_refund_fk" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id"),
        CONSTRAINT "ledger_entries_payout_fk" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id"),
        CONSTRAINT "ledger_entries_sequence_unique" UNIQUE ("sequence_number")
      )
    `);

    await queryRunner.query(`
      ALTER SEQUENCE "ledger_entry_sequence_seq" OWNED BY "ledger_entries"."sequence_number"
    `);

    await queryRunner.query(`
      CREATE TABLE "webhook_events" (
        "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
        "event_type" varchar NOT NULL,
        "payload" jsonb NOT NULL,
        "status" "webhook_event_status" NOT NULL,
        "attempts" integer NOT NULL DEFAULT 0,
        "next_retry_at" timestamptz,
        "payment_intent_id" uuid,
        "refund_id" uuid,
        "payout_id" uuid,
        "created_at" timestamptz NOT NULL DEFAULT now(),
        "updated_at" timestamptz NOT NULL DEFAULT now(),
        CONSTRAINT "webhook_events_attempts_non_negative" CHECK ("attempts" >= 0),
        CONSTRAINT "webhook_events_payment_intent_fk" FOREIGN KEY ("payment_intent_id") REFERENCES "payment_intents"("id"),
        CONSTRAINT "webhook_events_refund_fk" FOREIGN KEY ("refund_id") REFERENCES "refunds"("id"),
        CONSTRAINT "webhook_events_payout_fk" FOREIGN KEY ("payout_id") REFERENCES "payouts"("id")
      )
    `);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query(`DROP TABLE "webhook_events"`);
    await queryRunner.query(`DROP TABLE "ledger_entries"`);
    await queryRunner.query(`DROP SEQUENCE IF EXISTS "ledger_entry_sequence_seq"`);
    await queryRunner.query(`DROP TABLE "payouts"`);
    await queryRunner.query(`DROP TABLE "refunds"`);
    await queryRunner.query(`DROP TABLE "payment_intents"`);
    await queryRunner.query(`DROP TABLE "idempotency_keys"`);
    await queryRunner.query(`DROP TABLE "accounts"`);
    await queryRunner.query(`DROP TABLE "merchants"`);

    await queryRunner.query(`DROP TYPE "webhook_event_status"`);
    await queryRunner.query(`DROP TYPE "refund_status"`);
    await queryRunner.query(`DROP TYPE "payout_status"`);
    await queryRunner.query(`DROP TYPE "ledger_entry_type"`);
    await queryRunner.query(`DROP TYPE "account_type"`);
    await queryRunner.query(`DROP TYPE "idempotency_key_status"`);
    await queryRunner.query(`DROP TYPE "payment_intent_status"`);
  }
}
