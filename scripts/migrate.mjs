import { createRequire } from 'node:module';
import { readFile, readdir } from 'node:fs/promises';
import { databaseConfig } from './postgres-config.cjs';
const require = createRequire(new URL('../scaffolds/fun-launch/package.json', import.meta.url));

const databaseNeeded = Boolean(
  process.env.DATABASE_URL ||
  process.env.WHITELIST_ENABLED === 'true' ||
  process.env.FINANCIAL_WORKER_ENABLED === 'true' ||
  process.env.LAUNCH_POLICY_VERSION ||
  process.env.VAULT_PROGRAM_ID
);
if (!databaseNeeded) {
  console.log('Database features disabled; no migration needed.');
} else {
  let pool, client;
  try {
    const { Pool } = require('pg');
    pool = new Pool(databaseConfig());
    client = await pool.connect();
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('rinsed-schema'))");
    // Every migration is idempotent; apply them all in filename order
    const dir = new URL('./migrations/', import.meta.url);
    const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
    for (const file of files) {
      await client.query(await readFile(new URL(file, dir), 'utf8'));
    }
    await client.query('COMMIT');
    console.log('Application database schema ready.');
  } catch {
    await client?.query('ROLLBACK').catch(() => {});
    console.error('Database migration failed; release stopped.');
    process.exitCode = 1;
  } finally {
    client?.release();
    await pool?.end();
  }
}
