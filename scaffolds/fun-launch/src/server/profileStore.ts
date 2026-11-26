import { randomBytes } from 'node:crypto';
import type { Pool } from 'pg';
import { PublicKey } from '@solana/web3.js';
import { z } from 'zod';
import { database } from './database';
import { verifyWalletMessage } from './verifyWalletMessage';
import {
  safeAvatarUrl,
  socialMessage,
  type WalletProfile,
  type Callout,
  type SocialPurpose,
} from '@/lib/profiles';
import { CHAT_MESSAGE_MAX } from '@/lib/tokenChat';

export const socialWallet = z
  .string()
  .min(32)
  .max(44)
  .refine((value) => {
    try {
      const key = new PublicKey(value);
      return key.toBase58() === value && PublicKey.isOnCurve(key.toBytes());
    } catch {
      return false;
    }
  });
export const socialMint = z
  .string()
  .min(32)
  .max(44)
  .refine((value) => {
    try {
      return new PublicKey(value).toBase58() === value;
    } catch {
      return false;
    }
  });
const plain = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((value) => !/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/.test(value));
export const profileDraft = z
  .object({
    username: z
      .string()
      .trim()
      .toLowerCase()
      .regex(/^[a-z][a-z0-9_]{2,23}$/)
      .refine(
        (name) =>
          ![
            'admin',
            'administrator',
            'rinsed',
            'rinsed_fun',
            'mskd',
            'mskdfun',
            'masked',
            'plzzz',
            'plzzz_bond',
            'plzzzbond',
            'support',
            'moderator',
            'team',
            'official',
          ].includes(name)
      ),
    bio: plain(280),
    avatarUrl: z.string().max(500).refine(safeAvatarUrl),
  })
  .strict();
export const calloutDraft = z
  .object({
    networkGenesis: z.string().min(32).max(64),
    mint: socialMint,
    body: plain(500).refine((value) => value.length > 0),
  })
  .strict();
export const chatJoinDraft = calloutDraft.omit({ body: true });
const networkJoinDraft = chatJoinDraft.omit({ mint: true });
const challengeDrafts = {
  profile: profileDraft,
  callout: calloutDraft,
  chat: chatJoinDraft,
  'launch-preview': networkJoinDraft,
  otc: networkJoinDraft,
};
const challengeScope = (purpose: SocialPurpose) =>
  purpose === 'chat' || purpose === 'launch-preview' || purpose === 'otc' ? `${purpose}-` : '';
export const chatBody = plain(CHAT_MESSAGE_MAX).min(1);
export const socialSignature = z.string().regex(/^[A-Za-z0-9+/]{86}==$/);
export class SocialError extends Error {
  constructor(
    message: string,
    public status = 400
  ) {
    super(message);
  }
}

export class ProfileStore {
  constructor(private db: Pick<Pool, 'query' | 'connect'> = database()) {}
  async limit(bucket: string, maximum: number) {
    const result = await this.db.query<{ attempts: number }>(
      `INSERT INTO wallet_social_limits(bucket,attempts,expires_at)
      VALUES($1,1,now()+interval '1 hour') ON CONFLICT(bucket) DO UPDATE SET
      attempts=CASE WHEN wallet_social_limits.expires_at<=now() THEN 1 ELSE wallet_social_limits.attempts+1 END,
      expires_at=CASE WHEN wallet_social_limits.expires_at<=now() THEN now()+interval '1 hour' ELSE wallet_social_limits.expires_at END RETURNING attempts`,
      [bucket]
    );
    if ((result.rows[0]?.attempts ?? maximum + 1) > maximum)
      throw new SocialError('Too many requests. Try again later.', 429);
  }
  async profiles(wallets: string[]): Promise<WalletProfile[]> {
    return (
      await this.db.query<WalletProfile>(
        'SELECT wallet,username,bio,avatar_url,updated_at FROM wallet_profiles WHERE wallet=ANY($1::text[])',
        [wallets]
      )
    ).rows;
  }
  async callouts(genesis: string, mint: string, before: string | null): Promise<Callout[]> {
    return (
      await this.db.query<Callout>(
        `SELECT id::text,wallet,body,created_at FROM token_callouts
      WHERE network_genesis=$1 AND mint=$2 AND ($3::bigint IS NULL OR id<$3::bigint) ORDER BY id DESC LIMIT 20`,
        [genesis, mint, before]
      )
    ).rows;
  }
  async challenge(wallet: string, purpose: SocialPurpose, origin: string, raw: unknown) {
    const payload = challengeDrafts[purpose].parse(raw);
    const scope = challengeScope(purpose);
    await this.limit(`${scope}challenge-global`, 2000);
    await this.limit(`${scope}challenge:${wallet}`, 12);
    if ('networkGenesis' in payload && 'mint' in payload) {
      const p = payload;
      if (
        !(
          await this.db.query('SELECT 1 FROM launch_coins WHERE network_genesis=$1 AND mint=$2', [
            p.networkGenesis,
            p.mint,
          ])
        ).rows.length
      )
        throw new SocialError('This token is not available for discussion.', 404);
    }
    const nonce = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + 300_000).toISOString();
    const message = socialMessage(origin, wallet, purpose, payload, nonce, expiresAt);
    await this.db.query(
      `INSERT INTO wallet_social_challenges(nonce,wallet,purpose,origin,payload,message,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [nonce, wallet, purpose, origin, JSON.stringify(payload), message, expiresAt]
    );
    await this.db.query(
      `DELETE FROM wallet_social_challenges WHERE nonce IN (SELECT nonce FROM wallet_social_challenges WHERE expires_at<now()-interval '1 day' AND (used_at IS NULL OR purpose IN('profile','chat','launch-preview','otc')) LIMIT 100)`
    );
    await this.db.query(
      `DELETE FROM wallet_social_limits WHERE bucket IN (SELECT bucket FROM wallet_social_limits WHERE expires_at<now()-interval '1 day' LIMIT 100)`
    );
    return { nonce, message, expiresAt };
  }
  async submit(
    wallet: string,
    purpose: SocialPurpose,
    origin: string,
    nonce: string,
    signature: string
  ) {
    const scope = challengeScope(purpose);
    await this.limit(`${scope}submit:${wallet}`, 24);
    const client = await this.db.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`social:${wallet}`]);
      const found = await client.query<{ payload: unknown; message: string }>(
        `SELECT payload,message FROM wallet_social_challenges
        WHERE nonce=$1 AND wallet=$2 AND purpose=$3 AND origin=$4 AND used_at IS NULL AND expires_at>now() FOR UPDATE`,
        [nonce, wallet, purpose, origin]
      );
      const saved = found.rows[0];
      if (
        !saved ||
        !verifyWalletMessage(wallet, saved.message, signature) ||
        Buffer.from(signature, 'base64').toString('base64') !== signature
      )
        throw new SocialError(
          'The signed request expired, was already used, or does not match this wallet.'
        );
      let result: unknown;
      if (purpose === 'profile') {
        const data = profileDraft.parse(saved.payload);
        result = (
          await client.query<WalletProfile>(
            `INSERT INTO wallet_profiles(wallet,username,bio,avatar_url) VALUES($1,$2,$3,$4)
          ON CONFLICT(wallet) DO UPDATE SET username=EXCLUDED.username,bio=EXCLUDED.bio,avatar_url=EXCLUDED.avatar_url,updated_at=now()
          RETURNING wallet,username,bio,avatar_url,updated_at`,
            [wallet, data.username, data.bio, data.avatarUrl]
          )
        ).rows[0];
      } else if (purpose === 'callout') {
        const data = calloutDraft.parse(saved.payload);
        // Limit successful posts as well as challenges, across all instances.
        const count = await client.query(
          `SELECT id FROM token_callouts WHERE wallet=$1 AND created_at>now()-interval '1 hour' LIMIT 10`,
          [wallet]
        );
        if (count.rows.length >= 10)
          throw new SocialError('You can post up to 10 callouts per hour.', 429);
        result = (
          await client.query<Callout>(
            `INSERT INTO token_callouts(network_genesis,mint,wallet,body,challenge_nonce)
          VALUES($1,$2,$3,$4,$5) RETURNING id::text,wallet,body,created_at`,
            [data.networkGenesis, data.mint, wallet, data.body, nonce]
          )
        ).rows[0];
      } else result = challengeDrafts[purpose].parse(saved.payload);
      await client.query('UPDATE wallet_social_challenges SET used_at=now() WHERE nonce=$1', [
        nonce,
      ]);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505')
        throw new SocialError('That username is already taken.');
      throw error;
    } finally {
      client.release();
    }
  }
}
