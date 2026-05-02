import { Body, Controller, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/metadata/public.metadata';

@ApiTags('mock-webhook')
@Controller('mock')
export class MockMerchantWebhookController {
  @Post('merchant-webhook')
  @Public()
  @ApiOperation({ summary: 'Mock merchant webhook receiver for local testing' })
  receive(@Body() payload: unknown): { ok: true; received: unknown } {
    return { ok: true, received: payload };
  }
}
