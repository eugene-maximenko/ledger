import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { IdempotencyKey } from '../../database/entities/idempotency-key.entity';
import { PaymentIntent } from '../../database/entities/payment-intent.entity';
import { PaymentIntentsController } from './payment-intents.controller';
import { PaymentIntentsService } from './payment-intents.service';
import { PayoutWorkerController } from './payout-worker.controller';
import { ReconciliationController } from './reconciliation.controller';
import { TokenizationController } from './tokenization.controller';
import { WebhookDeliveryWorkerController } from './webhook-delivery-worker.controller';
import { MockMerchantWebhookController } from './mock-merchant-webhook.controller';

@Module({
  imports: [TypeOrmModule.forFeature([PaymentIntent, IdempotencyKey])],
  controllers: [
    PaymentIntentsController,
    TokenizationController,
    PayoutWorkerController,
    WebhookDeliveryWorkerController,
    MockMerchantWebhookController,
    ReconciliationController,
  ],
  providers: [PaymentIntentsService],
  exports: [PaymentIntentsService],
})
export class PaymentIntentsModule {}
