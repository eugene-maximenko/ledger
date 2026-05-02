import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';

export const typeOrmConfig = registerAs(
  'typeorm',
  (): TypeOrmModuleOptions => ({
    type: 'postgres',
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT),
    username: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    autoLoadEntities: true,
    synchronize: false,
    logging:
      process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test',
    migrationsRun:
      process.env.NODE_ENV !== 'production' && process.env.NODE_ENV !== 'test',
    migrationsTransactionMode: 'each',
    migrations: ['dist/database/migrations/*{.ts,.js}'],
  }),
);
