import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { PaymentIntentStatus } from '../db.enums';

@Entity('payment_intents')
export class PaymentIntent {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({
    type: 'enum',
    enum: PaymentIntentStatus,
    enumName: 'payment_intent_status',
  })
  status!: PaymentIntentStatus;

  @Column({ type: 'int' })
  amount!: number;

  @Column({ type: 'varchar', length: 3 })
  currency!: string;

  @Column({ name: 'capture_id', type: 'varchar', nullable: true })
  captureId!: string | null;

  @Column({ name: 'auth_code', type: 'varchar', nullable: true })
  authCode!: string | null;

  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @Column({ name: 'idempotency_key_id', type: 'uuid' })
  idempotencyKeyId!: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
