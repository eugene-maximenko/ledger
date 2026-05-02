import {
  Column,
  CreateDateColumn,
  Entity,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import { IdempotencyKeyStatus } from '../db.enums';

@Entity('idempotency_keys')
@Unique('idempotency_keys_merchant_key_unique', ['merchantId', 'key'])
export class IdempotencyKey {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  key!: string;

  @Column({ name: 'merchant_id', type: 'uuid' })
  merchantId!: string;

  @Column({
    type: 'enum',
    enum: IdempotencyKeyStatus,
    enumName: 'idempotency_key_status',
  })
  status!: IdempotencyKeyStatus;

  @Column({ type: 'jsonb', nullable: true })
  result!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @Column({ name: 'expires_at', type: 'timestamptz' })
  expiresAt!: Date;
}
