import { ApiProperty } from '@nestjs/swagger';

export class PaymentIntentsHealthResponseDto {
  @ApiProperty({
    description: 'Module name',
    example: 'payment-intents',
  })
  module!: string;

  @ApiProperty({
    description: 'Module health status',
    example: true,
  })
  ok!: true;
}
