import { Body, Controller, Headers, HttpCode, Param, ParseUUIDPipe, Post, Req } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiCreatedResponse,
  ApiHeader,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { CreatePaymentIntentDto } from './dto/create-payment-intent.dto';
import { CapturePaymentIntentDto } from './dto/capture-payment-intent.dto';
import { CancelPaymentIntentDto } from './dto/cancel-payment-intent.dto';
import { ConfirmPaymentIntentDto } from './dto/confirm-payment-intent.dto';
import { CreateRefundDto } from './dto/create-refund.dto';
import { PaymentIntentResponseDto } from './dto/payment-intent-response.dto';
import { RefundResponseDto } from './dto/refund-response.dto';
import { PaymentIntentsService } from './payment-intents.service';

@ApiTags('payment-intents')
@Controller('payment-intents')
export class PaymentIntentsController {
  constructor(private readonly paymentIntentsService: PaymentIntentsService) {}

  @Post(':id/confirm')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Confirm PaymentIntent (authorize, set processing)' })
  @ApiOkResponse({ type: PaymentIntentResponseDto })
  async confirm(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: ConfirmPaymentIntentDto,
  ): Promise<PaymentIntentResponseDto> {
    return this.paymentIntentsService.confirm(req.merchant!.id, id, body);
  }

  @Post(':id/capture')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Capture PaymentIntent (settle, ledger, payout)' })
  @ApiOkResponse({ type: PaymentIntentResponseDto })
  async capture(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: CapturePaymentIntentDto,
  ): Promise<PaymentIntentResponseDto> {
    return this.paymentIntentsService.capture(req.merchant!.id, id, body);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @ApiBearerAuth()
  @ApiOperation({ summary: 'Cancel PaymentIntent (pending only)' })
  @ApiOkResponse({ type: PaymentIntentResponseDto })
  async cancel(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Body() body: CancelPaymentIntentDto,
  ): Promise<PaymentIntentResponseDto> {
    return this.paymentIntentsService.cancel(req.merchant!.id, id, body);
  }

  @Post(':id/refunds')
  @ApiBearerAuth()
  @ApiHeader({ name: 'Idempotency-Key', required: false })
  @ApiOperation({ summary: 'Create refund for succeeded PaymentIntent' })
  @ApiCreatedResponse({ type: RefundResponseDto })
  async createRefund(
    @Req() req: Request,
    @Param('id', new ParseUUIDPipe({ version: '4' })) id: string,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: CreateRefundDto,
  ): Promise<RefundResponseDto> {
    return this.paymentIntentsService.createRefund(req.merchant!.id, id, idempotencyKey, body);
  }

  @Post()
  @ApiBearerAuth()
  @ApiHeader({ name: 'Idempotency-Key', required: true })
  @ApiOperation({ summary: 'Create PaymentIntent (pending)' })
  @ApiCreatedResponse({ type: PaymentIntentResponseDto })
  async create(
    @Req() req: Request,
    @Headers('idempotency-key') idempotencyKey: string | undefined,
    @Body() body: CreatePaymentIntentDto,
  ): Promise<PaymentIntentResponseDto> {
    return this.paymentIntentsService.create(
      req.merchant!.id,
      idempotencyKey ?? '',
      body,
    );
  }
}
