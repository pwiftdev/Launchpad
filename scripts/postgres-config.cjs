const fs = require('node:fs');

exports.databaseConfig = function databaseConfig(env = process.env) {
  if (!env.DATABASE_URL) throw new Error('Database is not configured');
  const url = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(url.protocol))
    throw new Error('Invalid database protocol');
  for (const key of ['sslmode', 'sslrootcert', 'sslcert', 'sslkey']) url.searchParams.delete(key);
  const certificate = env.DATABASE_SSL_CA || '/usr/lib/ssl/certs/ca-certificates.crt';
  return {
    connectionString: url.href,
    ssl: { rejectUnauthorized: true, ca: fs.readFileSync(certificate, 'utf8') },
    // Web requests, the live listener and an in-process indexer share this pool.
    max: Number(env.DATABASE_POOL_MAX) > 0 ? Number(env.DATABASE_POOL_MAX) : 8,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 30000,
    statement_timeout: 5000,
    application_name: 'rinsed-whitelist',
  };
};
