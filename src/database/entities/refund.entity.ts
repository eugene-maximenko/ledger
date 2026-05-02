import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { RefundStatus } from '../db.enums';

@Entity('refunds')
export class Refund {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'enum', enum: RefundStatus, enumName: 'refund_status' })
  status!: RefundStatus;

  @Column({ type: 'int' })
  amount!: number;

  @Column({ name: 'payment_intent_id', type: 'uuid' })
  paymentIntentId!: string;

  @Column({ name: 'idempotency_key_id', type: 'uuid' })
  idempotencyKeyId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
