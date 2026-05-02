import { ApiProperty } from '@nestjs/swagger';
import { Matches } from 'class-validator';

export class TokenizeCardDto {
  @ApiProperty({ example: '4242424242424242' })
  @Matches(/^\d{12,19}$/)
  cardNumber!: string;

  @ApiProperty({ example: '12/30', description: 'Format MM/YY' })
  @Matches(/^(0[1-9]|1[0-2])\/\d{2}$/)
  expiry!: string;

  @ApiProperty({ example: '123' })
  @Matches(/^\d{3,4}$/)
  cvv!: string;
}
