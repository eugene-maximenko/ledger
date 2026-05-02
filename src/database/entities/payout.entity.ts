import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { PayoutStatus } from '../db.enums';

@Entity('payouts')
export class Payout {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'enum', enum: PayoutStatus, enumName: 'payout_status' })
  status!: PayoutStatus;

  @Column({ type: 'int' })
  amount!: number;

  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @Column({ name: 'payment_intent_id', type: 'uuid' })
  paymentIntentId!: string;

  @Column({ name: 'available_at', type: 'timestamptz' })
  availableAt!: Date;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
