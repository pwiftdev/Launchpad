import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import { database } from './database';

export type UploadAdmission = { allowed: true } | { allowed: false; reason: 'replayed' | 'limit' };

/** Called only after signature verification. A shared transaction owns replay and cost limits. */
export async function consumeLaunchUpload(
  input: { wallet: string; signature: string },
  supplied?: Pick<Pool, 'connect'>
): Promise<UploadAdmission> {
  const bytes = Buffer.from(input.signature, 'base64');
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(input.wallet) || bytes.length !== 64)
    throw new Error('Invalid verified upload authorization');
  // Hash decoded bytes so alternate base64 padding bits cannot bypass replay protection.
  const digest = createHash('sha256').update(bytes).digest('hex');
  const client = await (supplied ?? database()).connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('rinsed-upload-budget-v1'))");
    await client.query('DELETE FROM launch_upload_authorizations WHERE expires_at <= now()');
    await client.query('DELETE FROM launch_upload_budgets WHERE expires_at <= now()');
    const capacity = await client.query<{ total: number }>(
      'SELECT count(*)::integer AS total FROM launch_upload_authorizations'
    );
    if ((capacity.rows[0]?.total ?? 10_000) >= 10_000) {
      await client.query('COMMIT');
      return { allowed: false, reason: 'limit' };
    }
    const consumed = await client.query(
      `INSERT INTO launch_upload_authorizations(authorization_digest,wallet)
       VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING authorization_digest`,
      [digest, input.wallet]
    );
    if (!consumed.rowCount) {
      await client.query('COMMIT');
      return { allowed: false, reason: 'replayed' };
    }
    const buckets = ['global', `wallet:${input.wallet}`];
    const rows = await client.query<{ bucket: string; attempts: number }>(
      'SELECT bucket,attempts FROM launch_upload_budgets WHERE bucket=ANY($1::text[])',
      [buckets]
    );
    if (rows.rows.some((row) => row.attempts >= (row.bucket === 'global' ? 20 : 3))) {
      // A denied signed attempt stays consumed; it cannot be replayed later on another web process.
      await client.query('COMMIT');
      return { allowed: false, reason: 'limit' };
    }
    for (const bucket of buckets)
      await client.query(
        `INSERT INTO launch_upload_budgets(bucket,attempts) VALUES($1,1)
         ON CONFLICT(bucket) DO UPDATE SET attempts=launch_upload_budgets.attempts+1`,
        [bucket]
      );
    await client.query('COMMIT');
    return { allowed: true };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
