import { ApiProperty } from '@nestjs/swagger';
import { IsInt, Min } from 'class-validator';

export class CreateRefundDto {
  @ApiProperty({ example: 9700, description: 'Refund amount in minor units (cents)' })
  @IsInt()
  @Min(1)
  amount!: number;
}
