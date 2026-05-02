import { ApiProperty } from '@nestjs/swagger';
import { RefundStatus } from '../../../database/db.enums';

export class RefundResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: RefundStatus })
  status!: RefundStatus;

  @ApiProperty()
  amount!: number;

  @ApiProperty({ format: 'uuid' })
  paymentIntentId!: string;

  @ApiProperty()
  createdAt!: string;
}
