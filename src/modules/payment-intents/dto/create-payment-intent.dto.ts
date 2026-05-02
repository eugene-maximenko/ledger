import { ApiProperty } from '@nestjs/swagger';
import { IsIn, IsInt, Min } from 'class-validator';

export const PAYMENT_INTENT_CURRENCIES = ['USD', 'EUR'] as const;
export type PaymentIntentCurrency = (typeof PAYMENT_INTENT_CURRENCIES)[number];

export class CreatePaymentIntentDto {
  @ApiProperty({ example: 10000, description: 'Amount in minor units (cents)' })
  @IsInt()
  @Min(1)
  amount!: number;

  @ApiProperty({ enum: PAYMENT_INTENT_CURRENCIES, example: 'USD' })
  @IsIn(PAYMENT_INTENT_CURRENCIES)
  currency!: PaymentIntentCurrency;
}
