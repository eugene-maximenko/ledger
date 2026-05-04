import { ApiProperty } from '@nestjs/swagger';

class ReconciliationInflowDto {
  @ApiProperty({ example: 1500 })
  total!: number;
}

class ReconciliationOutflowDto {
  @ApiProperty({ example: 45 })
  fees!: number;

  @ApiProperty({ example: 200 })
  refunds!: number;

  @ApiProperty({ example: 900 })
  payouts!: number;

  @ApiProperty({ example: 1145 })
  total!: number;
}

class ReconciliationTotalsDto {
  @ApiProperty({ type: ReconciliationInflowDto })
  inflow!: ReconciliationInflowDto;

  @ApiProperty({ type: ReconciliationOutflowDto })
  outflow!: ReconciliationOutflowDto;

  @ApiProperty({ example: 355 })
  net!: number;
}

class ReconciliationMovementDto {
  @ApiProperty({ example: '2026-04-20T09:00:00.000Z' })
  at!: string;

  @ApiProperty({ enum: ['capture', 'refund', 'payout_settlement'] })
  type!: 'capture' | 'refund' | 'payout_settlement';

  @ApiProperty({ example: 'pi_123' })
  referenceId!: string;

  @ApiProperty({ required: false, example: 1000, nullable: true })
  gross?: number;

  @ApiProperty({ required: false, example: 30, nullable: true })
  fee?: number;

  @ApiProperty({ required: false, example: 970, nullable: true })
  net?: number;

  @ApiProperty({ enum: ['in', 'out'] })
  direction!: 'in' | 'out';

  @ApiProperty({ example: 970 })
  amount!: number;
}

export class ReconciliationReportResponseDto {
  @ApiProperty({ format: 'uuid' })
  merchantId!: string;

  @ApiProperty({ example: 'USD' })
  currency!: string;

  @ApiProperty({ example: '2026-04-01T00:00:00.000Z' })
  periodFrom!: string;

  @ApiProperty({ example: '2026-04-30T23:59:59.999Z' })
  periodTo!: string;

  @ApiProperty({ example: 300 })
  openingBalance!: number;

  @ApiProperty({ example: 655 })
  closingBalance!: number;

  @ApiProperty({ type: ReconciliationTotalsDto })
  totals!: ReconciliationTotalsDto;

  @ApiProperty({ type: [ReconciliationMovementDto] })
  movements!: ReconciliationMovementDto[];
}
