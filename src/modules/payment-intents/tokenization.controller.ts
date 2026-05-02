import { Body, Controller, Post } from '@nestjs/common';
import { ApiBody, ApiCreatedResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/metadata/public.metadata';
import { PaymentIntentsService } from './payment-intents.service';
import { TokenizeCardResponseDto } from './dto/tokenize-card-response.dto';
import { TokenizeCardDto } from './dto/tokenize-card.dto';

@ApiTags('tokenize')
@Controller()
export class TokenizationController {
  constructor(private readonly paymentIntentsService: PaymentIntentsService) {}

  @Post('tokenize')
  @Public()
  @ApiOperation({ summary: 'Tokenize card data' })
  @ApiBody({ type: TokenizeCardDto })
  @ApiCreatedResponse({ type: TokenizeCardResponseDto })
  tokenize(@Body() body: TokenizeCardDto): TokenizeCardResponseDto {
    return this.paymentIntentsService.tokenizeCard(body);
  }
}
