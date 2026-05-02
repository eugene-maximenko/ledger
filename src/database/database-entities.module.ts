import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Account } from './entities/account.entity';
import { IdempotencyKey } from './entities/idempotency-key.entity';
import { LedgerEntry } from './entities/ledger-entry.entity';
import { Merchant } from './entities/merchant.entity';
import { PaymentIntent } from './entities/payment-intent.entity';
import { Payout } from './entities/payout.entity';
import { Refund } from './entities/refund.entity';
import { WebhookEvent } from './entities/webhook-event.entity';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      Merchant,
      Account,
      IdempotencyKey,
      PaymentIntent,
      Refund,
      Payout,
      LedgerEntry,
      WebhookEvent,
    ]),
  ],
  exports: [TypeOrmModule],
})
export class DatabaseEntitiesModule {}
