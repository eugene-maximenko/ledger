import {
  BadRequestException,
  ConflictException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { createHmac, randomUUID } from 'crypto';
import { DataSource, QueryRunner } from 'typeorm';
import {
  IdempotencyKeyStatus,
  LedgerEntryType,
  PaymentIntentStatus,
  PayoutStatus,
  RefundStatus,
  WebhookEventStatus,
} from '../../database/db.enums';
import {
  SEED_EXTERNAL_ACCOUNT_ID,
  SEED_ESCROW_ACCOUNT_ID,
  SEED_MERCHANT_PAYABLE_ACCOUNT_ID,
  SEED_REVENUE_ACCOUNT_ID,
  SEED_WEBHOOK_HMAC_SECRET,
} from '../../database/seed-constants';
import { CapturePaymentIntentDto } from './dto/capture-payment-intent.dto';
import { CancelPaymentIntentDto } from './dto/cancel-payment-intent.dto';
import { CreatePaymentIntentDto } from './dto/create-payment-intent.dto';
import { CreateRefundDto } from './dto/create-refund.dto';
import { ConfirmPaymentIntentDto } from './dto/confirm-payment-intent.dto';
import { PaymentIntentResponseDto } from './dto/payment-intent-response.dto';
import { PaymentIntentsHealthResponseDto } from './dto/payment-intents-health-response.dto';
import { RefundResponseDto } from './dto/refund-response.dto';
import { TokenizeCardDto } from './dto/tokenize-card.dto';
import { TokenizeCardResponseDto } from './dto/tokenize-card-response.dto';

const IDEMPOTENCY_TTL_MS = 24 * 60 * 60 * 1000;
const CAPTURE_COMMISSION_BPS = 300; // 3.00%
const BPS_BASE = 10_000;
const PAYOUT_DELAY_MS = 30 * 1000; // 30 seconds for pet-project settlement cadence
const DECLINE_TEST_CARD_NUMBER = '4000000000000002';
const DECLINE_TOKEN = 'tok_decline_card_declined';
const REFUND_DECLINE_CAPTURE_ID = 'cap_decline_refund';

type IdempotencyRow = {
  id: string;
  key: string;
  merchant_id: string;
  status: string;
  result: unknown;
};

type PaymentIntentRow = {
  id: string;
  status: string;
  amount: string;
  currency: string;
  auth_code: string | null;
  capture_id?: string | null;
  merchant_id: string;
  idempotency_key_id: string;
  created_at?: Date | string;
  createdAt?: Date | string;
};

type RefundRow = {
  id: string;
  status: string;
  amount: string;
  payment_intent_id: string;
  created_at?: Date | string;
  createdAt?: Date | string;
};

type PayoutRow = {
  id: string;
  status: string;
  amount: string;
};

type WebhookEventDeliveryRow = {
  id: string;
  event_type: string;
  payload: unknown;
  failed_attempts: string | number;
  payment_intent_id: string | null;
  refund_id: string | null;
  payout_id: string | null;
};

@Injectable()
export class PaymentIntentsService {
  private readonly logger = new Logger(PaymentIntentsService.name);

  constructor(private readonly dataSource: DataSource) {}

  getModuleHealth(): PaymentIntentsHealthResponseDto {
    return { module: 'payment-intents', ok: true };
  }

  tokenizeCard(dto: TokenizeCardDto): TokenizeCardResponseDto {
    if (dto.cardNumber === DECLINE_TEST_CARD_NUMBER) {
      return { cardToken: DECLINE_TOKEN };
    }
    return { cardToken: `tok_${randomUUID().replace(/-/g, '')}` };
  }

  async confirm(
    merchantId: string,
    paymentIntentId: string,
    dto: ConfirmPaymentIntentDto,
  ): Promise<PaymentIntentResponseDto> {
    const cardToken = dto.cardToken.trim();
    if (!cardToken) {
      throw new BadRequestException('cardToken is required');
    }

    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const rows = (await queryRunner.query(
        `SELECT * FROM "payment_intents"
         WHERE "id" = $1 AND "merchant_id" = $2
         FOR UPDATE`,
        [paymentIntentId, merchantId],
      )) as PaymentIntentRow[];
      const intent = rows[0];
      if (!intent) {
        throw new NotFoundException('PaymentIntent not found');
      }
      if (intent.status !== PaymentIntentStatus.Pending) {
        throw new ConflictException('PaymentIntent is not pending');
      }

      if (cardToken.startsWith('tok_decline_')) {
        await queryRunner.query(
          `UPDATE "payment_intents"
           SET "status" = $1, "auth_code" = NULL
           WHERE "id" = $2 AND "merchant_id" = $3`,
          [PaymentIntentStatus.Failed, paymentIntentId, merchantId],
        );

        const failedRows = (await queryRunner.query(
          `SELECT * FROM "payment_intents" WHERE "id" = $1 AND "merchant_id" = $2 LIMIT 1`,
          [paymentIntentId, merchantId],
        )) as PaymentIntentRow[];
        const failed = failedRows[0];
        if (!failed) {
          throw new InternalServerErrorException('PaymentIntent fail update failed');
        }

        await this.insertPendingWebhookEvent(queryRunner, {
          eventType: 'payment.failed',
          paymentIntentId: failed.id,
          payload: {
            type: 'payment.failed',
            data: {
              id: failed.id,
              object: 'payment_intent',
              status: failed.status,
              amount: Number(failed.amount),
              currency: failed.currency,
            },
          },
        });

        await queryRunner.commitTransaction();
        return this.mapIntentRowToResponse(failed);
      }

      const authCode = `auth_${randomUUID().replace(/-/g, '').slice(0, 16)}`;
      await queryRunner.query(
        `UPDATE "payment_intents"
         SET "status" = $1, "auth_code" = $2
         WHERE "id" = $3 AND "merchant_id" = $4`,
        [PaymentIntentStatus.Processing, authCode, paymentIntentId, merchantId],
      );

      const updatedRows = (await queryRunner.query(
        `SELECT * FROM "payment_intents" WHERE "id" = $1 AND "merchant_id" = $2 LIMIT 1`,
        [paymentIntentId, merchantId],
      )) as PaymentIntentRow[];
      const updated = updatedRows[0];
      if (!updated) {
        throw new InternalServerErrorException('PaymentIntent confirm update failed');
      }

      await queryRunner.commitTransaction();
      return this.mapIntentRowToResponse(updated);
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async create(
    merchantId: string,
    idempotencyKey: string,
    dto: CreatePaymentIntentDto,
  ): Promise<PaymentIntentResponseDto> {
    const trimmedKey = idempotencyKey.trim();
    if (!trimmedKey) {
      throw new BadRequestException('Idempotency-Key is required');
    }

    const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS);
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await queryRunner.query(
        `INSERT INTO "idempotency_keys" ("id", "key", "status", "expires_at", "merchant_id", "created_at")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW())
         ON CONFLICT ON CONSTRAINT "idempotency_keys_merchant_key_unique" DO NOTHING`,
        [trimmedKey, IdempotencyKeyStatus.Processing, expiresAt, merchantId],
      );

      const lockedRows = (await queryRunner.query(
        `SELECT * FROM "idempotency_keys" WHERE "merchant_id" = $1 AND "key" = $2 FOR UPDATE`,
        [merchantId, trimmedKey],
      )) as IdempotencyRow[];
      const idempotencyRow = lockedRows[0];
      if (!idempotencyRow) {
        throw new InternalServerErrorException('Idempotency row missing after insert');
      }

      if (
        idempotencyRow.status === IdempotencyKeyStatus.Completed &&
        idempotencyRow.result != null
      ) {
        await queryRunner.commitTransaction();
        return idempotencyRow.result as PaymentIntentResponseDto;
      }

      const existingIntent = (await queryRunner.query(
        `SELECT * FROM "payment_intents" WHERE "idempotency_key_id" = $1`,
        [idempotencyRow.id],
      )) as PaymentIntentRow[];

      if (existingIntent.length > 0) {
        const payload = this.mapIntentRowToResponse(existingIntent[0]);
        await queryRunner.query(
          `UPDATE "idempotency_keys" SET "status" = $1, "result" = $2::jsonb WHERE "id" = $3`,
          [IdempotencyKeyStatus.Completed, JSON.stringify(payload), idempotencyRow.id],
        );
        await queryRunner.commitTransaction();
        return payload;
      }

      const inserted = (await queryRunner.query(
        `INSERT INTO "payment_intents"
          ("status", "amount", "currency", "merchant_id", "idempotency_key_id", "created_at")
         VALUES ($1, $2, $3, $4, $5, NOW())
         RETURNING *`,
        [
          PaymentIntentStatus.Pending,
          dto.amount,
          dto.currency,
          merchantId,
          idempotencyRow.id,
        ],
      )) as PaymentIntentRow[];
      const intent = inserted[0];
      if (!intent) {
        throw new InternalServerErrorException('PaymentIntent insert failed');
      }

      const payload = this.mapIntentRowToResponse(intent);
      await queryRunner.query(
        `UPDATE "idempotency_keys" SET "status" = $1, "result" = $2::jsonb WHERE "id" = $3`,
        [IdempotencyKeyStatus.Completed, JSON.stringify(payload), idempotencyRow.id],
      );

      await queryRunner.commitTransaction();
      return payload;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async capture(
    merchantId: string,
    paymentIntentId: string,
    _dto: CapturePaymentIntentDto,
  ): Promise<PaymentIntentResponseDto> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const rows = (await queryRunner.query(
        `SELECT * FROM "payment_intents"
         WHERE "id" = $1 AND "merchant_id" = $2
         FOR UPDATE`,
        [paymentIntentId, merchantId],
      )) as PaymentIntentRow[];
      const intent = rows[0];
      if (!intent) {
        throw new NotFoundException('PaymentIntent not found');
      }
      if (intent.status !== PaymentIntentStatus.Processing) {
        throw new ConflictException('PaymentIntent is not processing');
      }

      const amount = Number(intent.amount);
      const commission = Math.round((amount * CAPTURE_COMMISSION_BPS) / BPS_BASE);
      const payoutAmount = amount - commission;
      const captureId = `cap_${randomUUID().replace(/-/g, '')}`;
      const availableAt = new Date(Date.now() + PAYOUT_DELAY_MS);

      await queryRunner.query(
        `UPDATE "payment_intents"
         SET "status" = $1, "capture_id" = $2
         WHERE "id" = $3 AND "merchant_id" = $4`,
        [PaymentIntentStatus.Succeeded, captureId, paymentIntentId, merchantId],
      );

      await queryRunner.query(
        `INSERT INTO "ledger_entries" ("id", "account_id", "type", "amount", "payment_intent_id", "created_at")
         VALUES
          (gen_random_uuid(), $1, $2, $3, $4, NOW()),
          (gen_random_uuid(), $5, $6, $7, $4, NOW()),
          (gen_random_uuid(), $8, $9, $10, $4, NOW())`,
        [
          SEED_EXTERNAL_ACCOUNT_ID,
          LedgerEntryType.Credit,
          amount,
          paymentIntentId,
          SEED_ESCROW_ACCOUNT_ID,
          LedgerEntryType.Debit,
          payoutAmount,
          SEED_REVENUE_ACCOUNT_ID,
          LedgerEntryType.Debit,
          commission,
        ],
      );

      await queryRunner.query(
        `INSERT INTO "payouts" ("id", "status", "amount", "merchant_id", "payment_intent_id", "available_at", "created_at")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, NOW())`,
        [PayoutStatus.Pending, payoutAmount, merchantId, paymentIntentId, availableAt],
      );

      await this.insertPendingWebhookEvent(queryRunner, {
        eventType: 'payment.succeeded',
        paymentIntentId,
        payload: {
          type: 'payment.succeeded',
          data: {
            id: paymentIntentId,
            object: 'payment_intent',
            status: PaymentIntentStatus.Succeeded,
            amount,
            currency: intent.currency,
          },
        },
      });

      const updatedRows = (await queryRunner.query(
        `SELECT * FROM "payment_intents" WHERE "id" = $1 AND "merchant_id" = $2 LIMIT 1`,
        [paymentIntentId, merchantId],
      )) as PaymentIntentRow[];
      const updated = updatedRows[0];
      if (!updated) {
        throw new InternalServerErrorException('PaymentIntent capture update failed');
      }

      await queryRunner.commitTransaction();
      return this.mapIntentRowToResponse(updated);
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async cancel(
    merchantId: string,
    paymentIntentId: string,
    _dto: CancelPaymentIntentDto,
  ): Promise<PaymentIntentResponseDto> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const rows = (await queryRunner.query(
        `SELECT * FROM "payment_intents"
         WHERE "id" = $1 AND "merchant_id" = $2
         FOR UPDATE`,
        [paymentIntentId, merchantId],
      )) as PaymentIntentRow[];
      const intent = rows[0];
      if (!intent) {
        throw new NotFoundException('PaymentIntent not found');
      }
      if (intent.status !== PaymentIntentStatus.Pending) {
        throw new ConflictException('PaymentIntent is not pending');
      }

      await queryRunner.query(
        `UPDATE "payment_intents"
         SET "status" = $1
         WHERE "id" = $2 AND "merchant_id" = $3`,
        [PaymentIntentStatus.Cancelled, paymentIntentId, merchantId],
      );

      const updatedRows = (await queryRunner.query(
        `SELECT * FROM "payment_intents" WHERE "id" = $1 AND "merchant_id" = $2 LIMIT 1`,
        [paymentIntentId, merchantId],
      )) as PaymentIntentRow[];
      const updated = updatedRows[0];
      if (!updated) {
        throw new InternalServerErrorException('PaymentIntent cancel update failed');
      }

      await this.insertPendingWebhookEvent(queryRunner, {
        eventType: 'payment.cancelled',
        paymentIntentId,
        payload: {
          type: 'payment.cancelled',
          data: {
            id: updated.id,
            object: 'payment_intent',
            status: updated.status,
            amount: Number(updated.amount),
            currency: updated.currency,
          },
        },
      });

      await queryRunner.commitTransaction();
      return this.mapIntentRowToResponse(updated);
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async createRefund(
    merchantId: string,
    paymentIntentId: string,
    idempotencyKey: string | undefined,
    dto: CreateRefundDto,
  ): Promise<RefundResponseDto> {
    const trimmedInputKey = idempotencyKey?.trim();
    const key = trimmedInputKey && trimmedInputKey.length > 0 ? trimmedInputKey : `auto-refund-${randomUUID()}`;
    const expiresAt = new Date(Date.now() + IDEMPOTENCY_TTL_MS);
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      await queryRunner.query(
        `INSERT INTO "idempotency_keys" ("id", "key", "status", "expires_at", "merchant_id", "created_at")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW())
         ON CONFLICT ON CONSTRAINT "idempotency_keys_merchant_key_unique" DO NOTHING`,
        [key, IdempotencyKeyStatus.Processing, expiresAt, merchantId],
      );

      const idempotencyRows = (await queryRunner.query(
        `SELECT * FROM "idempotency_keys" WHERE "merchant_id" = $1 AND "key" = $2 FOR UPDATE`,
        [merchantId, key],
      )) as IdempotencyRow[];
      const idempotencyRow = idempotencyRows[0];
      if (!idempotencyRow) {
        throw new InternalServerErrorException('Idempotency row missing after insert');
      }

      if (
        idempotencyRow.status === IdempotencyKeyStatus.Completed &&
        idempotencyRow.result != null
      ) {
        await queryRunner.commitTransaction();
        return idempotencyRow.result as RefundResponseDto;
      }

      const intentRows = (await queryRunner.query(
        `SELECT * FROM "payment_intents"
         WHERE "id" = $1 AND "merchant_id" = $2
         FOR UPDATE`,
        [paymentIntentId, merchantId],
      )) as PaymentIntentRow[];
      const intent = intentRows[0];
      if (!intent) {
        throw new NotFoundException('PaymentIntent not found');
      }
      if (intent.status !== PaymentIntentStatus.Succeeded) {
        throw new ConflictException('PaymentIntent is not succeeded');
      }

      const grossAmount = Number(intent.amount);
      const commission = Math.round((grossAmount * CAPTURE_COMMISSION_BPS) / BPS_BASE);
      const refundableBase = grossAmount - commission;

      const reservedRefundRows = (await queryRunner.query(
        `SELECT "amount" FROM "refunds"
         WHERE "payment_intent_id" = $1 AND "status" IN ($2, $3)
         FOR UPDATE`,
        [paymentIntentId, RefundStatus.Pending, RefundStatus.Succeeded],
      )) as { amount: string }[];
      const refundedTotal = reservedRefundRows.reduce((sum, row) => sum + Number(row.amount), 0);
      const refundableLeft = refundableBase - refundedTotal;
      if (dto.amount > refundableLeft) {
        throw new ConflictException('Refund amount exceeds refundable_left');
      }

      const shouldFail = intent.capture_id === REFUND_DECLINE_CAPTURE_ID;
      const insertedRefundRows = (await queryRunner.query(
        `INSERT INTO "refunds" ("id", "status", "amount", "payment_intent_id", "idempotency_key_id", "created_at")
         VALUES (gen_random_uuid(), $1, $2, $3, $4, NOW())
         RETURNING *`,
        [RefundStatus.Pending, dto.amount, paymentIntentId, idempotencyRow.id],
      )) as RefundRow[];
      const refund = insertedRefundRows[0];
      if (!refund) {
        throw new InternalServerErrorException('Refund insert failed');
      }

      const payload = this.mapRefundRowToResponse(refund);
      await queryRunner.query(
        `UPDATE "idempotency_keys" SET "status" = $1, "result" = $2::jsonb WHERE "id" = $3`,
        [IdempotencyKeyStatus.Completed, JSON.stringify(payload), idempotencyRow.id],
      );

      await queryRunner.commitTransaction();
      // Mock async processor: we intentionally simulate out-of-band bank reverse completion.
      void this.processRefundMockAsync(refund.id, shouldFail);
      return payload;
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async settleDuePayouts(): Promise<{ processed: number }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const duePayouts = (await queryRunner.query(
        `SELECT * FROM "payouts"
         WHERE "status" = $1 AND "available_at" <= NOW()
         ORDER BY "available_at" ASC
         FOR UPDATE SKIP LOCKED`,
        [PayoutStatus.Pending],
      )) as PayoutRow[];

      for (const payout of duePayouts) {
        const amount = Number(payout.amount);

        await queryRunner.query(
          `UPDATE "payouts"
           SET "status" = $1
           WHERE "id" = $2 AND "status" = $3`,
          [PayoutStatus.Paid, payout.id, PayoutStatus.Pending],
        );

        await queryRunner.query(
          `INSERT INTO "ledger_entries" ("id", "account_id", "type", "amount", "payout_id", "created_at")
           VALUES
            (gen_random_uuid(), $1, $2, $3, $4, NOW()),
            (gen_random_uuid(), $5, $6, $3, $4, NOW())`,
          [
            SEED_ESCROW_ACCOUNT_ID,
            LedgerEntryType.Debit,
            amount,
            payout.id,
            SEED_MERCHANT_PAYABLE_ACCOUNT_ID,
            LedgerEntryType.Credit,
          ],
        );

        await this.insertPendingWebhookEvent(queryRunner, {
          eventType: 'payout.paid',
          payoutId: payout.id,
          payload: {
            type: 'payout.paid',
            data: {
              id: payout.id,
              object: 'payout',
              status: PayoutStatus.Paid,
              amount,
            },
          },
        });
      }

      await queryRunner.commitTransaction();
      return { processed: duePayouts.length };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  async deliverPendingWebhooks(): Promise<{ processed: number }> {
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const rows = (await queryRunner.query(
        `SELECT
           w."id",
           w."event_type",
           w."payload",
           w."failed_attempts",
           w."payment_intent_id",
           w."refund_id",
           w."payout_id"
         FROM "webhook_events" w
         WHERE w."status" = $1
           AND (w."next_retry_at" IS NULL OR w."next_retry_at" <= NOW())
         ORDER BY w."created_at" ASC
         FOR UPDATE SKIP LOCKED`,
        [WebhookEventStatus.Pending],
      )) as WebhookEventDeliveryRow[];

      let processed = 0;
      for (const row of rows) {
        processed += 1;

        const webhookUrl = await this.getWebhookUrlForEvent(queryRunner, row);
        if (!webhookUrl) {
          await queryRunner.query(
            `UPDATE "webhook_events"
             SET "status" = $1, "next_retry_at" = NULL, "last_http_status" = NULL, "last_error" = $2, "last_attempt_at" = NOW(), "updated_at" = NOW()
             WHERE "id" = $3`,
            [WebhookEventStatus.Failed, 'merchant webhook_url is null', row.id],
          );
          continue;
        }

        const attemptsBefore = Number(row.failed_attempts);
        const delivery = await this.sendWebhook(webhookUrl, row.payload);

        if (delivery.ok) {
          await queryRunner.query(
            `UPDATE "webhook_events"
             SET "status" = $1, "next_retry_at" = NULL, "last_http_status" = $2, "last_error" = NULL, "last_attempt_at" = NOW(), "updated_at" = NOW()
             WHERE "id" = $3`,
            [WebhookEventStatus.Delivered, delivery.httpStatus ?? null, row.id],
          );
          continue;
        }

        const attemptsAfter = attemptsBefore + 1;
        if (attemptsAfter >= 5) {
          await queryRunner.query(
            `UPDATE "webhook_events"
             SET "status" = $1, "failed_attempts" = $2, "next_retry_at" = NULL, "last_http_status" = $3, "last_error" = $4, "last_attempt_at" = NOW(), "updated_at" = NOW()
             WHERE "id" = $5`,
            [WebhookEventStatus.Failed, attemptsAfter, delivery.httpStatus ?? null, delivery.error ?? null, row.id],
          );
          continue;
        }

        const retryAt = new Date(Date.now() + this.getWebhookRetryDelayMs(attemptsAfter));
        await queryRunner.query(
          `UPDATE "webhook_events"
           SET "status" = $1, "failed_attempts" = $2, "next_retry_at" = $3, "last_http_status" = $4, "last_error" = $5, "last_attempt_at" = NOW(), "updated_at" = NOW()
           WHERE "id" = $6`,
          [
            WebhookEventStatus.Pending,
            attemptsAfter,
            retryAt,
            delivery.httpStatus ?? null,
            delivery.error ?? null,
            row.id,
          ],
        );
      }

      await queryRunner.commitTransaction();
      return { processed };
    } catch (err) {
      await queryRunner.rollbackTransaction();
      throw err;
    } finally {
      await queryRunner.release();
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async runPayoutSettlementCron(): Promise<void> {
    try {
      await this.settleDuePayouts();
    } catch (error) {
      this.logger.error('Payout settlement cron failed', error as Error);
    }
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async runWebhookDeliveryCron(): Promise<void> {
    try {
      await this.deliverPendingWebhooks();
    } catch (error) {
      this.logger.error('Webhook delivery cron failed', error as Error);
    }
  }

  async getReconciliationReport(
    merchantId: string,
    from: Date,
    to: Date,
    currency: string,
  ): Promise<Record<string, unknown>> {
    const openingRows = (await this.dataSource.query(
      `SELECT COALESCE(SUM(
         CAST(pi."amount" AS integer) - ROUND((CAST(pi."amount" AS numeric) * $1) / $2)
       ), 0)::int AS s
       FROM "payment_intents" pi
       WHERE pi."merchant_id" = $3
         AND pi."currency" = $4
         AND pi."status" = $5
         AND pi."created_at" < $6::timestamptz`,
      [CAPTURE_COMMISSION_BPS, BPS_BASE, merchantId, currency, PaymentIntentStatus.Succeeded, from.toISOString()],
    )) as { s: number }[];
    const openingBalance = Number(openingRows[0]?.s ?? 0);

    const grossRows = (await this.dataSource.query(
      `SELECT COALESCE(SUM(pi."amount"), 0)::int AS s
       FROM "payment_intents" pi
       WHERE pi."merchant_id" = $1
         AND pi."currency" = $2
         AND pi."status" = $3
         AND pi."created_at" >= $4::timestamptz
         AND pi."created_at" <= $5::timestamptz`,
      [merchantId, currency, PaymentIntentStatus.Succeeded, from.toISOString(), to.toISOString()],
    )) as { s: number }[];
    const inflowTotal = Number(grossRows[0]?.s ?? 0);
    const feeOutflow = Math.round((inflowTotal * CAPTURE_COMMISSION_BPS) / BPS_BASE);

    const refundRows = (await this.dataSource.query(
      `SELECT COALESCE(SUM(r."amount"), 0)::int AS s
       FROM "refunds" r
       INNER JOIN "payment_intents" pi ON pi."id" = r."payment_intent_id"
       WHERE pi."merchant_id" = $1
         AND pi."currency" = $2
         AND r."status" = $3
         AND r."created_at" >= $4::timestamptz
         AND r."created_at" <= $5::timestamptz`,
      [merchantId, currency, RefundStatus.Succeeded, from.toISOString(), to.toISOString()],
    )) as { s: number }[];
    const refundOutflow = Number(refundRows[0]?.s ?? 0);

    const payoutRows = (await this.dataSource.query(
      `SELECT COALESCE(SUM(p."amount"), 0)::int AS s
       FROM "payouts" p
       INNER JOIN "payment_intents" pi ON pi."id" = p."payment_intent_id"
       WHERE p."merchant_id" = $1
         AND pi."currency" = $2
         AND p."status" = $3
         AND p."created_at" >= $4::timestamptz
         AND p."created_at" <= $5::timestamptz`,
      [merchantId, currency, PayoutStatus.Paid, from.toISOString(), to.toISOString()],
    )) as { s: number }[];
    const payoutOutflow = Number(payoutRows[0]?.s ?? 0);

    const outflowTotal = feeOutflow + refundOutflow + payoutOutflow;
    const net = inflowTotal - outflowTotal;
    const closingBalance = openingBalance + net;

    const revenueRows = (await this.dataSource.query(
      `SELECT COALESCE(SUM(le."amount"), 0)::int AS s
       FROM "ledger_entries" le
       WHERE le."account_id" = $1
         AND le."type" = 'debit'
         AND le."created_at" >= $2::timestamptz
         AND le."created_at" <= $3::timestamptz`,
      [SEED_REVENUE_ACCOUNT_ID, from.toISOString(), to.toISOString()],
    )) as { s: number }[];
    const revenue = Number(revenueRows[0]?.s ?? 0);

    const pendingRows = (await this.dataSource.query(
      `SELECT COALESCE(SUM(p."amount"), 0)::int AS s
       FROM "payouts" p
       INNER JOIN "payment_intents" pi ON pi."id" = p."payment_intent_id"
       WHERE p."merchant_id" = $1
         AND pi."currency" = $2
         AND p."status" = $3`,
      [merchantId, currency, PayoutStatus.Pending],
    )) as { s: number }[];
    const pendingPayouts = Number(pendingRows[0]?.s ?? 0);

    const merchantNetCapturedRows = (await this.dataSource.query(
      `SELECT COALESCE(SUM(
         CAST(pi."amount" AS integer) - ROUND((CAST(pi."amount" AS numeric) * $1) / $2)
       ), 0)::int AS s
       FROM "payment_intents" pi
       WHERE pi."merchant_id" = $3
         AND pi."currency" = $4
         AND pi."status" = $5`,
      [CAPTURE_COMMISSION_BPS, BPS_BASE, merchantId, currency, PaymentIntentStatus.Succeeded],
    )) as { s: number }[];
    const merchantNetCaptured = Number(merchantNetCapturedRows[0]?.s ?? 0);

    const succeededRefundsAllTimeRows = (await this.dataSource.query(
      `SELECT COALESCE(SUM(r."amount"), 0)::int AS s
       FROM "refunds" r
       INNER JOIN "payment_intents" pi ON pi."id" = r."payment_intent_id"
       WHERE pi."merchant_id" = $1
         AND pi."currency" = $2
         AND r."status" = $3`,
      [merchantId, currency, RefundStatus.Succeeded],
    )) as { s: number }[];
    const succeededRefundsAllTime = Number(succeededRefundsAllTimeRows[0]?.s ?? 0);

    const paidPayoutsAllTimeRows = (await this.dataSource.query(
      `SELECT COALESCE(SUM(p."amount"), 0)::int AS s
       FROM "payouts" p
       INNER JOIN "payment_intents" pi ON pi."id" = p."payment_intent_id"
       WHERE p."merchant_id" = $1
         AND pi."currency" = $2
         AND p."status" = $3`,
      [merchantId, currency, PayoutStatus.Paid],
    )) as { s: number }[];
    const paidPayoutsAllTime = Number(paidPayoutsAllTimeRows[0]?.s ?? 0);

    const escrowLiability = merchantNetCaptured - succeededRefundsAllTime - paidPayoutsAllTime;

    const captures = (await this.dataSource.query(
      `SELECT pi."id", pi."amount", pi."created_at"
       FROM "payment_intents" pi
       WHERE pi."merchant_id" = $1
         AND pi."currency" = $2
         AND pi."status" = $3
         AND pi."created_at" >= $4::timestamptz
         AND pi."created_at" <= $5::timestamptz
       ORDER BY pi."created_at" ASC`,
      [merchantId, currency, PaymentIntentStatus.Succeeded, from.toISOString(), to.toISOString()],
    )) as { id: string; amount: string; created_at: string }[];

    const refunds = (await this.dataSource.query(
      `SELECT r."id", r."amount", r."created_at"
       FROM "refunds" r
       INNER JOIN "payment_intents" pi ON pi."id" = r."payment_intent_id"
       WHERE pi."merchant_id" = $1
         AND pi."currency" = $2
         AND r."status" = $3
         AND r."created_at" >= $4::timestamptz
         AND r."created_at" <= $5::timestamptz
       ORDER BY r."created_at" ASC`,
      [merchantId, currency, RefundStatus.Succeeded, from.toISOString(), to.toISOString()],
    )) as { id: string; amount: string; created_at: string }[];

    const payoutMovements = (await this.dataSource.query(
      `SELECT p."id", p."amount", p."created_at"
       FROM "payouts" p
       INNER JOIN "payment_intents" pi ON pi."id" = p."payment_intent_id"
       WHERE p."merchant_id" = $1
         AND pi."currency" = $2
         AND p."status" = $3
         AND p."created_at" >= $4::timestamptz
         AND p."created_at" <= $5::timestamptz
       ORDER BY p."created_at" ASC`,
      [merchantId, currency, PayoutStatus.Paid, from.toISOString(), to.toISOString()],
    )) as { id: string; amount: string; created_at: string }[];

    const movements = [
      ...captures.map((c) => {
        const gross = Number(c.amount);
        const fee = Math.round((gross * CAPTURE_COMMISSION_BPS) / BPS_BASE);
        const netAmount = gross - fee;
        return {
          at: new Date(c.created_at).toISOString(),
          type: 'capture' as const,
          referenceId: c.id,
          gross,
          fee,
          net: netAmount,
          direction: 'in' as const,
          amount: netAmount,
        };
      }),
      ...refunds.map((r) => ({
        at: new Date(r.created_at).toISOString(),
        type: 'refund' as const,
        referenceId: r.id,
        direction: 'out' as const,
        amount: Number(r.amount),
      })),
      ...payoutMovements.map((p) => ({
        at: new Date(p.created_at).toISOString(),
        type: 'payout_settlement' as const,
        referenceId: p.id,
        direction: 'out' as const,
        amount: Number(p.amount),
      })),
    ].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());

    return {
      merchantId,
      currency,
      periodFrom: from.toISOString(),
      periodTo: to.toISOString(),
      openingBalance,
      closingBalance,
      totals: {
        inflow: {
          total: inflowTotal,
        },
        outflow: {
          fees: feeOutflow,
          refunds: refundOutflow,
          payouts: payoutOutflow,
          total: outflowTotal,
        },
        net,
      },
      movements,
      revenue,
      pendingPayouts,
      escrowLiability,
    };
  }

  private async processRefundMockAsync(refundId: string, shouldFail: boolean): Promise<void> {
    await Promise.resolve();
    const queryRunner = this.dataSource.createQueryRunner();
    await queryRunner.connect();
    await queryRunner.startTransaction();

    try {
      const refundRows = (await queryRunner.query(
        `SELECT * FROM "refunds" WHERE "id" = $1 FOR UPDATE`,
        [refundId],
      )) as RefundRow[];
      const refund = refundRows[0];
      if (!refund || refund.status !== RefundStatus.Pending) {
        await queryRunner.rollbackTransaction();
        return;
      }

      const finalStatus = shouldFail ? RefundStatus.Failed : RefundStatus.Succeeded;
      await queryRunner.query(
        `UPDATE "refunds" SET "status" = $1 WHERE "id" = $2`,
        [finalStatus, refundId],
      );

      if (finalStatus === RefundStatus.Succeeded) {
        await queryRunner.query(
          `INSERT INTO "ledger_entries" ("id", "account_id", "type", "amount", "refund_id", "created_at")
           VALUES
            (gen_random_uuid(), $1, $2, $3, $4, NOW()),
            (gen_random_uuid(), $1, $5, $3, $4, NOW())`,
          [
            SEED_ESCROW_ACCOUNT_ID,
            LedgerEntryType.Debit,
            Number(refund.amount),
            refund.id,
            LedgerEntryType.Credit,
          ],
        );
        await queryRunner.query(
          `UPDATE "payouts"
           SET "amount" = GREATEST("amount" - $1, 0),
               "status" = CASE
                 WHEN GREATEST("amount" - $1, 0) = 0 THEN $4
                 ELSE "status"
               END
           WHERE "payment_intent_id" = $2
             AND "status" = $3`,
          [
            Number(refund.amount),
            refund.payment_intent_id,
            PayoutStatus.Pending,
            PayoutStatus.Cancelled,
          ],
        );
        await this.insertPendingWebhookEvent(queryRunner, {
          eventType: 'refund.succeeded',
          refundId: refund.id,
          payload: {
            type: 'refund.succeeded',
            data: {
              id: refund.id,
              object: 'refund',
              status: RefundStatus.Succeeded,
              amount: Number(refund.amount),
              payment_intent_id: refund.payment_intent_id,
            },
          },
        });
      } else {
        await this.insertPendingWebhookEvent(queryRunner, {
          eventType: 'refund.failed',
          refundId: refund.id,
          payload: {
            type: 'refund.failed',
            data: {
              id: refund.id,
              object: 'refund',
              status: RefundStatus.Failed,
              amount: Number(refund.amount),
              payment_intent_id: refund.payment_intent_id,
            },
          },
        });
      }

      await queryRunner.commitTransaction();
    } catch {
      await queryRunner.rollbackTransaction();
    } finally {
      await queryRunner.release();
    }
  }

  private getWebhookRetryDelayMs(attemptsAfterFailure: number): number {
    if (attemptsAfterFailure === 1) return 1 * 60 * 1000;
    if (attemptsAfterFailure === 2) return 5 * 60 * 1000;
    if (attemptsAfterFailure === 3) return 30 * 60 * 1000;
    if (attemptsAfterFailure === 4) return 2 * 60 * 60 * 1000;
    return 8 * 60 * 60 * 1000;
  }

  private async getWebhookUrlForEvent(
    queryRunner: QueryRunner,
    row: WebhookEventDeliveryRow,
  ): Promise<string | null> {
    const rows = (await queryRunner.query(
      `SELECT COALESCE(
         (SELECT m."webhook_url"
          FROM "payment_intents" pi
          JOIN "merchants" m ON m."id" = pi."merchant_id"
          WHERE pi."id" = $1),
         (SELECT m."webhook_url"
          FROM "refunds" r
          JOIN "payment_intents" pi ON pi."id" = r."payment_intent_id"
          JOIN "merchants" m ON m."id" = pi."merchant_id"
          WHERE r."id" = $2),
         (SELECT m."webhook_url"
          FROM "payouts" p
          JOIN "merchants" m ON m."id" = p."merchant_id"
          WHERE p."id" = $3)
       ) AS "webhook_url"`,
      [row.payment_intent_id, row.refund_id, row.payout_id],
    )) as { webhook_url: string | null }[];
    return rows[0]?.webhook_url ?? null;
  }

  private async sendWebhook(
    url: string,
    payload: unknown,
  ): Promise<{ ok: boolean; httpStatus: number | null; error: string | null }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 2000);
    try {
      const rawBody = JSON.stringify(payload);
      const timestamp = Date.now().toString();
      const signature = createHmac('sha256', SEED_WEBHOOK_HMAC_SECRET)
        .update(`${timestamp}.${rawBody}`)
        .digest('hex');
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-webhook-timestamp': timestamp,
          'x-webhook-signature': signature,
        },
        body: rawBody,
        signal: controller.signal,
      });
      return { ok: response.ok, httpStatus: response.status, error: null };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, httpStatus: null, error: message };
    } finally {
      clearTimeout(timeout);
    }
  }

  private async insertPendingWebhookEvent(
    queryRunner: QueryRunner,
    o: {
      eventType: string;
      payload: Record<string, unknown>;
      paymentIntentId?: string | null;
      refundId?: string | null;
      payoutId?: string | null;
    },
  ): Promise<void> {
    await queryRunner.query(
      `INSERT INTO "webhook_events" ("id", "event_type", "payload", "status", "failed_attempts", "next_retry_at", "payment_intent_id", "refund_id", "payout_id", "created_at", "updated_at")
       VALUES (gen_random_uuid(), $1, $2::jsonb, $3, 0, NULL, $4, $5, $6, NOW(), NOW())`,
      [
        o.eventType,
        JSON.stringify(o.payload),
        WebhookEventStatus.Pending,
        o.paymentIntentId ?? null,
        o.refundId ?? null,
        o.payoutId ?? null,
      ],
    );
  }

  private mapIntentRowToResponse(row: PaymentIntentRow): PaymentIntentResponseDto {
    const createdAtRaw = row.created_at ?? row.createdAt;
    const createdAtDate = createdAtRaw instanceof Date ? createdAtRaw : createdAtRaw ? new Date(createdAtRaw) : null;
    const createdAt = createdAtDate && !Number.isNaN(createdAtDate.getTime())
      ? createdAtDate.toISOString()
      : new Date().toISOString();
    return {
      id: row.id,
      status: row.status as PaymentIntentStatus,
      amount: Number(row.amount),
      currency: row.currency,
      merchantId: row.merchant_id,
      createdAt,
    };
  }

  private mapRefundRowToResponse(row: RefundRow): RefundResponseDto {
    const createdAtRaw = row.created_at ?? row.createdAt;
    const createdAtDate = createdAtRaw instanceof Date ? createdAtRaw : createdAtRaw ? new Date(createdAtRaw) : null;
    const createdAt = createdAtDate && !Number.isNaN(createdAtDate.getTime())
      ? createdAtDate.toISOString()
      : new Date().toISOString();
    return {
      id: row.id,
      status: row.status as RefundStatus,
      amount: Number(row.amount),
      paymentIntentId: row.payment_intent_id,
      createdAt,
    };
  }
}
