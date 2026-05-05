import * as path from 'path';
import * as dotenv from 'dotenv';

process.env.NODE_ENV = 'test';
process.env.DOTENV_CONFIG_PATH = 'test/.env.test';
process.env.DOTENV_CONFIG_QUIET = 'true';
process.env.PORT = process.env.PORT ?? '3099';

dotenv.config({ path: path.resolve(process.cwd(), 'test/.env.test'), quiet: true });
