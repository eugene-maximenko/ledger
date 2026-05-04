import 'reflect-metadata';
import * as fs from 'fs';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { DataSource } from 'typeorm';

const envLoadedPath = path.resolve(
  process.cwd(),
  process.env.DOTENV_CONFIG_PATH ?? '.env',
);
if (fs.existsSync(envLoadedPath)) {
  dotenv.config({ path: envLoadedPath });
}

export default new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: Number(process.env.DB_PORT),
  username: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  entities: ['src/**/*.entity.ts', 'dist/**/*.entity.js'],
  migrations: [
    path.join(__dirname, 'migrations', '*.ts'),
    path.join(__dirname, 'migrations', '*.js'),
  ],
  migrationsTransactionMode: 'each',
});
