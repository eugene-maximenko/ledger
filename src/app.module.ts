import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { ScheduleModule } from '@nestjs/schedule';
import { TypeOrmModule } from '@nestjs/typeorm';
import { validateEnvironment } from './config/env.validation';
import { DatabaseEntitiesModule } from './database/database-entities.module';
import { typeOrmConfig } from './database/typeorm.config';
import { AuthModule } from './modules/auth/auth.module';
import { MerchantAuthGuard } from './modules/auth/merchant-auth.guard';
import { HealthController } from './modules/health/health.controller';
import { PaymentIntentsModule } from './modules/payment-intents/payment-intents.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: '.env',
      validate: validateEnvironment,
      load: [typeOrmConfig],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: (configService: ConfigService) =>
        configService.getOrThrow('typeorm'),
    }),
    ScheduleModule.forRoot(),
    DatabaseEntitiesModule,
    AuthModule,
    PaymentIntentsModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: MerchantAuthGuard }],
})
export class AppModule {}
