import { createHmac } from 'node:crypto';
import { database } from './database';

export async function adminLoginLimit(identity: string, maximum: number): Promise<boolean> {
  const secret = process.env.WHITELIST_SECRET;
  if (!secret || secret.length < 32)
    throw new Error('Admin rate limit authentication is not configured');
  const result = await database().query<{ attempts: number }>(
    `
    INSERT INTO whitelist_limits(bucket, attempts, expires_at) VALUES ($1, 1, now() + interval '1 hour')
    ON CONFLICT (bucket) DO UPDATE SET
      attempts = CASE WHEN whitelist_limits.expires_at <= now() THEN 1 ELSE whitelist_limits.attempts + 1 END,
      expires_at = CASE WHEN whitelist_limits.expires_at <= now() THEN now() + interval '1 hour' ELSE whitelist_limits.expires_at END
    RETURNING attempts`,
    [createHmac('sha256', secret).update(identity).digest('hex')]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Attempt counter was not recorded');
  return row.attempts <= maximum;
}
