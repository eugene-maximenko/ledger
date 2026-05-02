import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { Merchant } from '../../database/entities/merchant.entity';
import { MerchantAuthGuard } from './merchant-auth.guard';

@Module({
  imports: [TypeOrmModule.forFeature([Merchant])],
  providers: [MerchantAuthGuard],
  exports: [MerchantAuthGuard, TypeOrmModule],
})
export class AuthModule {}
