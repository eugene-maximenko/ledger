import { ApiProperty } from '@nestjs/swagger';
import { PaymentIntentStatus } from '../../../database/db.enums';

export class PaymentIntentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: PaymentIntentStatus })
  status!: PaymentIntentStatus;

  @ApiProperty()
  amount!: number;

  @ApiProperty({ example: 'USD' })
  currency!: string;

  @ApiProperty({ format: 'uuid' })
  merchantId!: string;

  @ApiProperty()
  createdAt!: string;
}
