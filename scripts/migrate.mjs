import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { databaseConfig } from './postgres-config.cjs';
const require = createRequire(new URL('../scaffolds/fun-launch/package.json', import.meta.url));

const databaseNeeded = Boolean(
  process.env.DATABASE_URL ||
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
    const journal = await client.query("SELECT to_regclass('launch_schema_migrations') AS name");
    const applied = new Map(
      journal.rows[0].name
        ? (await client.query('SELECT filename,sha256 FROM launch_schema_migrations')).rows.map(
            (row) => [row.filename, row.sha256]
          )
        : []
    );
    const dir = new URL('./migrations/', import.meta.url);
    const files = (await readdir(dir)).filter((name) => name.endsWith('.sql')).sort();
    const pending = [];
    for (const file of files) {
      const source = (await readFile(new URL(file, dir), 'utf8')).replace(/\r\n/g, '\n');
      const hash = createHash('sha256').update(source).digest('hex');
      if (applied.has(file)) {
        if (applied.get(file) !== hash) throw new Error('Applied migration changed');
        continue;
      }
      await client.query(source);
      pending.push([file, hash]);
    }
    for (const revision of pending)
      await client.query(
        'INSERT INTO launch_schema_migrations(filename,sha256) VALUES($1,$2)',
        revision
      );
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
