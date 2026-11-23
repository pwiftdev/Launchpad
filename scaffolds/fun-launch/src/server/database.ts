import { Pool } from 'pg';
import { databaseConfig } from '../../../../scripts/postgres-config.cjs';

let pool: Pool | undefined;
export function database(): Pool {
  if (!pool) {
    pool = new Pool(databaseConfig());
    pool.on('error', () => console.error('Database connection interrupted'));
  }
  return pool;
}
