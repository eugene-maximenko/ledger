import { Column, CreateDateColumn, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { LedgerEntryType } from '../db.enums';

@Entity('ledger_entries')
export class LedgerEntry {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'account_id', type: 'uuid' })
  accountId!: string;

  @Column({ type: 'enum', enum: LedgerEntryType, enumName: 'ledger_entry_type' })
  type!: LedgerEntryType;

  @Column({ type: 'int' })
  amount!: number;

  @Column({ name: 'sequence_number', type: 'bigint', unique: true })
  sequenceNumber!: string;

  @Column({ name: 'payment_intent_id', type: 'uuid', nullable: true })
  paymentIntentId!: string | null;

  @Column({ name: 'refund_id', type: 'uuid', nullable: true })
  refundId!: string | null;

  @Column({ name: 'payout_id', type: 'uuid', nullable: true })
  payoutId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
