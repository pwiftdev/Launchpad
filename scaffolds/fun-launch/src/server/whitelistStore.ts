import { randomBytes, randomInt, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { database } from './database';
import { whitelistBucket } from './whitelistAuth';
import {
  REFERRAL_ALPHABET,
  whitelistMessage,
  type WhitelistInterest,
  type WhitelistReceipt,
} from '@/lib/whitelist';

type Entry = {
  wallet: string;
  registration_id: string;
  interest: WhitelistInterest;
  status: WhitelistReceipt['status'];
  joined_at: Date;
  referral_code: string;
  referrals: string | number;
};
export const toReceipt = (entry: Entry): WhitelistReceipt => ({
  wallet: entry.wallet,
  registrationId: entry.registration_id,
  interest: entry.interest,
  status: entry.status,
  joinedAt: new Date(entry.joined_at).toISOString(),
  referralCode: entry.referral_code,
  referrals: Number(entry.referrals),
});

// Receipt columns plus how many non-revoked wallets joined through this wallet's link
const RECEIPT_SELECT = `
  SELECT e.wallet, e.registration_id, e.interest, e.status, e.joined_at, e.referral_code,
    (SELECT count(*) FROM whitelist_entries r WHERE r.referred_by = e.wallet AND r.status <> 'revoked') AS referrals
  FROM whitelist_entries e`;

export function generateReferralCode(): string {
  let code = '';
  for (let i = 0; i < 8; i++) code += REFERRAL_ALPHABET[randomInt(REFERRAL_ALPHABET.length)];
  return code;
}

export async function whitelistLimit(identity: string, maximum: number): Promise<boolean> {
  const result = await database().query<{ attempts: number }>(
    `
    INSERT INTO whitelist_limits(bucket, attempts, expires_at) VALUES ($1, 1, now() + interval '1 hour')
    ON CONFLICT (bucket) DO UPDATE SET
      attempts = CASE WHEN whitelist_limits.expires_at <= now() THEN 1 ELSE whitelist_limits.attempts + 1 END,
      expires_at = CASE WHEN whitelist_limits.expires_at <= now() THEN now() + interval '1 hour' ELSE whitelist_limits.expires_at END
    RETURNING attempts`,
    [whitelistBucket(identity)]
  );
  const row = result.rows[0];
  if (!row) throw new Error('Attempt counter was not recorded');
  return row.attempts <= maximum;
}

/** Wallet behind a referral code, if it is an active registration. */
export async function findReferrer(code: string): Promise<string | null> {
  const result = await database().query<{ wallet: string }>(
    "SELECT wallet FROM whitelist_entries WHERE referral_code=$1 AND status <> 'revoked'",
    [code]
  );
  return result.rows[0]?.wallet ?? null;
}

export async function createChallenge(
  wallet: string,
  interest: WhitelistInterest,
  origin: string,
  referralCode: string | null = null
) {
  // Only keep invites from a different, active registration; anything else is silently dropped
  const referrer = referralCode ? await findReferrer(referralCode) : null;
  const code = referrer && referrer !== wallet ? referralCode : null;
  const issuedAt = new Date();
  const expiresAt = new Date(issuedAt.getTime() + 5 * 60_000);
  const nonce = randomBytes(32).toString('hex');
  const message = whitelistMessage({
    origin,
    wallet,
    interest,
    nonce,
    issuedAt: issuedAt.toISOString(),
    expiresAt: expiresAt.toISOString(),
    referralCode: code,
  });
  await database().query(
    'INSERT INTO whitelist_challenges(nonce, wallet, interest, message, expires_at, referral_code) VALUES ($1,$2,$3,$4,$5,$6)',
    [nonce, wallet, interest, message, expiresAt, code]
  );
  await database().query(
    "DELETE FROM whitelist_challenges WHERE nonce IN (SELECT nonce FROM whitelist_challenges WHERE expires_at < now() - interval '1 day' LIMIT 100)"
  );
  await database().query(
    'DELETE FROM whitelist_limits WHERE bucket IN (SELECT bucket FROM whitelist_limits WHERE expires_at < now() LIMIT 100)'
  );
  return { nonce, message, expiresAt: expiresAt.toISOString() };
}

export async function getChallenge(
  nonce: string,
  wallet: string
): Promise<{ message: string } | undefined> {
  const result = await database().query<{ message: string }>(
    'SELECT message FROM whitelist_challenges WHERE nonce=$1 AND wallet=$2 AND consumed_at IS NULL AND expires_at > now()',
    [nonce, wallet]
  );
  return result.rows[0];
}

/** Inserts the entry with a fresh referral code, retrying on the (very unlikely) code collision. */
async function insertEntry(
  client: PoolClient,
  values: {
    wallet: string;
    interest: WhitelistInterest;
    message: string;
    signature: string;
    referredBy: string | null;
  }
) {
  for (let attempt = 0; attempt < 3; attempt++) {
    await client.query('SAVEPOINT entry');
    try {
      await client.query(
        'INSERT INTO whitelist_entries(wallet, registration_id, interest, signed_message, signature, referral_code, referred_by) VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (wallet) DO NOTHING',
        [
          values.wallet,
          randomUUID(),
          values.interest,
          values.message,
          values.signature,
          generateReferralCode(),
          values.referredBy,
        ]
      );
      await client.query('RELEASE SAVEPOINT entry');
      return;
    } catch (error) {
      await client.query('ROLLBACK TO SAVEPOINT entry');
      if ((error as { code?: string }).code !== '23505' || attempt === 2) throw error;
    }
  }
}

export async function registerWallet(
  nonce: string,
  wallet: string,
  signature: string
): Promise<WhitelistReceipt | null> {
  const client = await database().connect();
  try {
    await client.query('BEGIN');
    const consumed = await client.query<{
      interest: WhitelistInterest;
      message: string;
      referral_code: string | null;
    }>(
      'UPDATE whitelist_challenges SET consumed_at=now() WHERE nonce=$1 AND wallet=$2 AND consumed_at IS NULL AND expires_at > now() RETURNING interest, message, referral_code',
      [nonce, wallet]
    );
    const challenge = consumed.rows[0];
    if (!challenge) {
      await client.query('ROLLBACK');
      return null;
    }
    // Re-check the referrer at registration time: it must still be a different, active wallet
    const referrer = challenge.referral_code
      ? ((
          await client.query<{ wallet: string }>(
            "SELECT wallet FROM whitelist_entries WHERE referral_code=$1 AND status <> 'revoked' AND wallet <> $2",
            [challenge.referral_code, wallet]
          )
        ).rows[0]?.wallet ?? null)
      : null;
    await insertEntry(client, {
      wallet,
      interest: challenge.interest,
      message: challenge.message,
      signature,
      referredBy: referrer,
    });
    const registered = await client.query<Entry>(`${RECEIPT_SELECT} WHERE e.wallet=$1`, [wallet]);
    const receipt = registered.rows[0];
    if (!receipt) throw new Error('Registration was not recorded');
    await client.query('COMMIT');
    countCache = null;
    return toReceipt(receipt);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function getRegistration(
  wallet: string,
  registrationId: string
): Promise<WhitelistReceipt | null> {
  const result = await database().query<Entry>(
    `${RECEIPT_SELECT} WHERE e.wallet=$1 AND e.registration_id=$2`,
    [wallet, registrationId]
  );
  const entry = result.rows[0];
  return entry ? toReceipt(entry) : null;
}

// The public count is read on every page view; a short cache keeps that off the database
const COUNT_TTL_MS = 15_000;
let countCache: { at: number; count: number } | null = null;

/** Active (non-revoked) registrations. */
export async function whitelistCount(fresh = false): Promise<number> {
  if (!fresh && countCache && Date.now() - countCache.at < COUNT_TTL_MS) return countCache.count;
  const result = await database().query<{ count: string }>(
    "SELECT count(*) FROM whitelist_entries WHERE status <> 'revoked'"
  );
  const value = result.rows[0]?.count;
  const count = Number(value);
  if (value === undefined || !Number.isSafeInteger(count) || count < 0)
    throw new Error('Registration count is unavailable');
  countCache = { at: Date.now(), count };
  return countCache.count;
}
