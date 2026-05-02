import { ApiProperty } from '@nestjs/swagger';

export class TokenizeCardResponseDto {
  @ApiProperty({ example: 'tok_mock_123' })
  cardToken!: string;
}
