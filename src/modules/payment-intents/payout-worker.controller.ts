import { Controller, HttpCode, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { Public } from '../../common/metadata/public.metadata';
import { PaymentIntentsService } from './payment-intents.service';

@ApiTags('internal-workers')
@Controller('internal/workers/payout-settlement')
export class PayoutWorkerController {
  constructor(private readonly paymentIntentsService: PaymentIntentsService) {}

  @Post('tick')
  @HttpCode(200)
  @Public()
  @ApiOperation({ summary: 'Run payout settlement worker tick (pet-project mock)' })
  async tick(): Promise<{ processed: number }> {
    return this.paymentIntentsService.settleDuePayouts();
  }
}
