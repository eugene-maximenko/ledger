import { Column, Entity, PrimaryGeneratedColumn } from 'typeorm';
import { AccountType } from '../db.enums';

@Entity('accounts')
export class Account {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'enum', enum: AccountType, enumName: 'account_type', unique: true })
  type!: AccountType;
}
