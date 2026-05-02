import {
  BadRequestException,
  Controller,
  Get,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { ReconciliationReportResponseDto } from './dto/reconciliation-report-response.dto';
import { PaymentIntentsService } from './payment-intents.service';

@ApiTags('reconciliation')
@Controller('reconciliation')
export class ReconciliationController {
  constructor(private readonly paymentIntentsService: PaymentIntentsService) {}

  @Get('report')
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Get reconciliation report for merchant and period' })
  @ApiOkResponse({
    description: 'Reconciliation report summary',
    type: ReconciliationReportResponseDto,
  })
  @ApiQuery({ name: 'currency', required: true, example: 'USD' })
  @ApiQuery({
    name: 'to',
    required: true,
    description: 'ISO timestamp (period end)',
    example: '2030-04-30T00:00:00.000Z',
  })
  @ApiQuery({
    name: 'from',
    required: true,
    description: 'ISO timestamp (period start)',
    example: '2026-04-01T00:00:00.000Z',
  })
  async getReport(
    @Req() req: Request,
    @Query('from') from: string | undefined,
    @Query('to') to: string | undefined,
    @Query('currency') currency: string | undefined,
  ): Promise<Record<string, unknown>> {
    if (!from || !to || !currency) {
      throw new BadRequestException('from, to and currency are required');
    }
    const fromDate = new Date(from);
    const toDate = new Date(to);
    if (Number.isNaN(fromDate.getTime()) || Number.isNaN(toDate.getTime())) {
      throw new BadRequestException('Invalid from/to date');
    }
    if (fromDate > toDate) {
      throw new BadRequestException('from must be <= to');
    }

    return this.paymentIntentsService.getReconciliationReport(
      req.merchant!.id,
      fromDate,
      toDate,
      currency,
    );
  }
}
