import { createRequire } from 'node:module';
import { databaseConfig } from './postgres-config.cjs';
const require = createRequire(new URL('../scaffolds/fun-launch/package.json', import.meta.url));
const { Pool } = require('pg');
// Operator-only report: access requires database credentials (e.g. a Heroku one-off dyno).
const referralReport = process.argv.includes('--referrals');
const pool = new Pool(databaseConfig());
try {
  const result = await pool.query(`
    SELECT e.wallet, e.registration_id, e.interest, e.status, e.joined_at, e.referral_code, e.referred_by,
      (SELECT count(*) FROM whitelist_entries r WHERE r.referred_by = e.wallet AND r.status <> 'revoked') AS referrals
    FROM whitelist_entries e
    ${referralReport ? "WHERE e.status <> 'revoked' ORDER BY referrals DESC, e.joined_at, e.wallet" : 'ORDER BY e.joined_at, e.wallet'}`);
  const columns = referralReport
    ? ['wallet', 'referrals', 'referral_code', 'status', 'joined_at']
    : ['wallet', 'registration_id', 'interest', 'status', 'joined_at', 'referral_code', 'referred_by', 'referrals'];
  console.log(columns.join(','));
  for (const row of result.rows) {
    console.log(columns.map((column) => {
      const value = row[column] instanceof Date ? row[column].toISOString() : (row[column] ?? '');
      return `"${String(value).replaceAll('"', '""')}"`;
    }).join(','));
  }
} catch { console.error('Whitelist export failed; verify database access.'); process.exitCode = 1; }
finally { await pool.end(); }
