import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import { Keypair } from '@solana/web3.js';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { assertSocialChallenge, type SocialChallenge } from '@/lib/profiles';
import type { ChatFeed } from '@/lib/tokenChat';
import { CHAT_COOKIE } from '@/server/chatSecurity';
import handler from '@/pages/api/token-chat';
import { walletFixture } from './walletFixture';

const storage = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
vi.mock('@/server/database', () => ({ database: () => storage }));
const origin = 'https://chat.example';
const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG';
const mint = Keypair.generate().publicKey.toBase58();
const secondMint = Keypair.generate().publicKey.toBase58();
let db: PGlite;

beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  await db.exec(
    'CREATE TABLE launch_coins(network_genesis text,mint varchar(44),PRIMARY KEY(network_genesis,mint));'
  );
  for (const file of ['020-wallet-profiles.sql', '029-token-chat.sql']) {
    await db.exec(
      readFileSync(new URL(`../../../../../scripts/migrations/${file}`, import.meta.url), 'utf8')
    );
  }
  await db.query('INSERT INTO launch_coins VALUES($1,$2),($1,$3)', [genesis, mint, secondMint]);
  storage.query.mockImplementation((text: string, args?: unknown[]) => db.query(text, args));
  storage.connect.mockResolvedValue({ query: storage.query, release: () => {} });
}, 20_000);
beforeEach(async () => {
  vi.stubEnv('LAUNCHPAD_PUBLIC', 'true');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', origin);
  vi.stubEnv('NEXT_PUBLIC_NETWORK', 'devnet');
  vi.stubEnv('DATABASE_URL', 'postgresql://fixture');
  vi.stubEnv('TOKEN_CHAT_SECRET', 'd1'.repeat(32));
  await db.exec(
    'TRUNCATE wallet_social_challenges, wallet_social_limits, token_chat_messages CASCADE'
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => db.close());

async function request(
  body?: object,
  options: {
    cookie?: string;
    wallet?: string;
    mint?: string;
    before?: string;
    origin?: string;
  } = {}
) {
  const headers = new Map<string, string>();
  let status = 200;
  let result: unknown;
  const res = {
    setHeader(key: string, value: string) {
      headers.set(key.toLowerCase(), value);
    },
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      result = value;
    },
  };
  const req = {
    url: '/api/token-chat',
    method: body ? 'POST' : 'GET',
    headers: {
      host: new URL(origin).host,
      origin: options.origin ?? origin,
      'content-type': 'application/json',
      'x-chat-wallet': options.wallet,
    },
    cookies: { [CHAT_COOKIE]: options.cookie },
    query: { mint: options.mint ?? mint, ...(options.before ? { before: options.before } : {}) },
    socket: { remoteAddress: '192.0.2.1' },
    body,
  };
  await handler(req as unknown as NextApiRequest, res as unknown as NextApiResponse);
  return {
    status,
    data: result,
    cookie: headers
      .get('set-cookie')
      ?.split(';')[0]
      ?.slice(CHAT_COOKIE.length + 1),
    headers,
  };
}

async function session(user: ReturnType<typeof walletFixture>) {
  const initial = await request({ action: 'challenge', wallet: user.wallet, mint });
  expect(initial.status).toBe(200);
  const challenge = initial.data as SocialChallenge;
  assertSocialChallenge(challenge, origin, user.wallet, 'chat', { mint });
  const join = {
    action: 'join',
    wallet: user.wallet,
    nonce: challenge.nonce,
    signature: user.sign(challenge.message),
  };
  const result = await request(join);
  expect(result.status).toBe(200);
  expect(result.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Strict; Path=/');
  expect(result.cookie).toBeTruthy();
  return { wallet: user.wallet, cookie: result.cookie, join };
}

it('requires a wallet signature, blocks replay and restricts writes to the site origin', async () => {
  const alice = walletFixture();
  const wrong = walletFixture();
  expect((await request()).status).toBe(401);
  expect(
    (await request({ action: 'post', mint, clientId: randomUUID(), body: 'hello' })).status
  ).toBe(401);
  const challenge = (await request({ action: 'challenge', wallet: alice.wallet, mint }))
    .data as SocialChallenge;
  expect(
    (
      await request({
        action: 'join',
        wallet: alice.wallet,
        nonce: challenge.nonce,
        signature: wrong.sign(challenge.message),
      })
    ).status
  ).toBe(400);
  const signed = await session(alice);
  expect((await request(signed.join)).status).toBe(400);
  expect((await request(undefined, { ...signed, wallet: wrong.wallet })).status).toBe(401);
  expect((await request(undefined, { ...signed, cookie: signed.cookie + 'a' })).status).toBe(401);
  expect(
    (await request({ action: 'leave' }, { ...signed, origin: 'https://outside.example' })).status
  ).toBe(403);
  expect((await request({ action: 'leave' }, signed)).headers.get('set-cookie')).toContain(
    'Max-Age=0'
  );
});

it('persists ciphertext once and only exposes a message in its own room', async () => {
  const alice = await session(walletFixture());
  const bob = await session(walletFixture());
  const body = 'Hello to this room only';
  const post = { action: 'post', mint, clientId: randomUUID(), body };
  expect((await request(post, alice)).status).toBe(200);
  expect((await request(post, alice)).status).toBe(200);
  const { rows } = await db.query<{ ciphertext: Uint8Array; author: string }>(
    'SELECT ciphertext,author FROM token_chat_messages'
  );
  expect(rows).toHaveLength(1);
  expect(Buffer.from(rows[0]!.ciphertext).includes(Buffer.from(body))).toBe(false);
  expect(rows[0]!.author).not.toBe(alice.wallet);
  const first = await request(undefined, bob);
  expect(first.status).toBe(200);
  expect(first.headers.get('cache-control')).toContain('no-store');
  expect((first.data as ChatFeed).messages).toMatchObject([{ author: rows[0]!.author, body }]);
  const other = (await request(undefined, { ...bob, mint: secondMint })).data as ChatFeed;
  expect(other.messages).toEqual([]);
  expect(other.viewer).not.toBe((first.data as ChatFeed).viewer);
  const unknown = Keypair.generate().publicKey.toBase58();
  expect((await request(undefined, { ...bob, mint: unknown })).status).toBe(404);
  expect((await request({ ...post, mint: unknown }, alice)).status).toBe(404);
});

it('expires sessions and safely rejects tampered stored text', async () => {
  const alice = await session(walletFixture());
  expect(
    (await request({ action: 'post', mint, clientId: randomUUID(), body: 'Encrypted text' }, alice))
      .status
  ).toBe(200);
  await db.exec(
    'UPDATE token_chat_messages SET ciphertext=set_byte(ciphertext,15,255-get_byte(ciphertext,15))'
  );
  const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
  const unreadable = await request(undefined, alice);
  expect(unreadable.status).toBe(503);
  expect(JSON.stringify(unreadable.data)).not.toContain('Encrypted text');
  expect(warning).toHaveBeenCalledWith('Token chat request failed');
  const later = Date.now() + 3600_001;
  vi.spyOn(Date, 'now').mockReturnValue(later);
  expect((await request(undefined, alice)).status).toBe(401);
});
