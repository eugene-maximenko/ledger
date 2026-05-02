import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class ConfirmPaymentIntentDto {
  @ApiProperty({ example: 'tok_mock_123' })
  @IsString()
  @IsNotEmpty()
  @Matches(/^tok_[A-Za-z0-9_]+$/)
  cardToken!: string;
}
