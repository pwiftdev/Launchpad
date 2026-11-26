import { createHash, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { NextApiRequest, NextApiResponse } from 'next';
import sharp from 'sharp';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { assertSocialChallenge, type SocialChallenge } from '@/lib/profiles';
import type {
  LaunchPreviewDraft,
  PreviewInvite,
  SavedPreview,
  SharedPreview,
} from '@/lib/launchPreview';
import handler from '@/pages/api/launch-previews';
import { getServerSideProps } from '@/pages/launch-preview';
import { largeLaunchArtwork } from './launchArtworkFixture';
import { walletFixture } from './walletFixture';

const storage = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
vi.mock('@/server/database', () => ({ database: () => storage }));
const origin = 'https://preview.example';
const cookieName = '__Host-mskd_preview';
let db: PGlite;
let draft: LaunchPreviewDraft;

beforeAll(async () => {
  db = new PGlite();
  await db.waitReady;
  await db.exec(
    'CREATE TABLE launch_coins(network_genesis text,mint varchar(44),PRIMARY KEY(network_genesis,mint));'
  );
  for (const file of [
    '020-wallet-profiles.sql',
    '029-token-chat.sql',
    '030-private-launch-previews.sql',
  ]) {
    await db.exec(
      readFileSync(new URL(`../../../../../scripts/migrations/${file}`, import.meta.url), 'utf8')
    );
  }
  storage.query.mockImplementation((query: string, params?: unknown[]) => db.query(query, params));
  storage.connect.mockResolvedValue({ query: storage.query, release: () => {} });
  const png = await sharp({ create: { width: 12, height: 12, channels: 3, background: '#FF7800' } })
    .png()
    .toBuffer();
  draft = {
    tokenName: 'Private draft name',
    tokenSymbol: 'DRAFT',
    tokenLogo: `data:image/png;base64,${png.toString('base64')}`,
    sourceUrl: 'https://x.com/mskdfun/status/123456',
    description: 'This description should never appear in logs or public search.',
    socials: { website: 'masked.example', twitter: '@mskdfun' },
    devBuyPercent: 2,
    mode: 'dev',
  };
}, 20_000);
beforeEach(async () => {
  vi.stubEnv('LAUNCHPAD_PUBLIC', 'true');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', origin);
  vi.stubEnv('NEXT_PUBLIC_NETWORK', 'devnet');
  vi.stubEnv('DATABASE_URL', 'postgresql://fixture');
  vi.stubEnv('LAUNCH_PREVIEW_SECRET', 'a3'.repeat(32));
  await db.exec(
    'TRUNCATE wallet_social_challenges,wallet_social_limits,launch_preview_drafts CASCADE'
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => db.close());

async function request<T = unknown>(
  body: object,
  options: { wallet?: string; cookie?: string; origin?: string; method?: string } = {}
) {
  const headers = new Map<string, string>();
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const req = {
    method: options.method ?? 'POST',
    url: '/api/launch-previews',
    headers: {
      origin: options.origin ?? origin,
      'content-type': 'application/json',
      'x-preview-wallet': options.wallet,
    },
    cookies: { [cookieName]: options.cookie },
    socket: { remoteAddress: '192.0.2.42' },
    body,
  };
  await handler(
    req as unknown as NextApiRequest,
    {
      setHeader: (key: string, value: string) => headers.set(key.toLowerCase(), value),
      status,
      json,
    } as unknown as NextApiResponse
  );
  return {
    status: status.mock.lastCall?.[0],
    data: json.mock.lastCall?.[0] as T,
    cookie: headers
      .get('set-cookie')
      ?.split(';')[0]
      ?.slice(cookieName.length + 1),
    headers,
  };
}

async function session(user = walletFixture()) {
  const { wallet } = user;
  const { data: challenge } = await request<SocialChallenge>({ action: 'challenge', wallet });
  assertSocialChallenge(challenge, origin, wallet, 'launch-preview', null);
  const join = {
    action: 'join',
    wallet,
    nonce: challenge.nonce,
    signature: user.sign(challenge.message),
  };
  const response = await request(join);
  expect(response.status).toBe(200);
  expect(response.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Strict; Path=/');
  return { wallet, cookie: response.cookie, join };
}

async function createInvite(
  owner: Awaited<ReturnType<typeof session>>,
  viewerWallet: string | null = null,
  revision = 1
) {
  const response = await request<{ token: string; invite: PreviewInvite }>(
    { action: 'invite', viewerWallet, hours: 24, revision },
    owner
  );
  expect(response.status).toBe(200);
  return response.data;
}

it('gates the preview shell and returns only static no-store props', async () => {
  const setHeader = vi.fn();
  const context = {
    req: { cookies: {} },
    res: { setHeader },
    resolvedUrl: '/launch-preview',
    query: { draft: 'server must ignore this' },
  } as unknown as Parameters<typeof getServerSideProps>[0];
  expect(await getServerSideProps(context)).toEqual({ props: {} });
  expect(setHeader).toHaveBeenCalledWith('X-Robots-Tag', 'noindex, nofollow, noarchive');
  expect(setHeader).toHaveBeenCalledWith('Referrer-Policy', 'no-referrer');
  expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  vi.stubEnv('LAUNCHPAD_PUBLIC', 'false');
  expect(await getServerSideProps(context)).toHaveProperty('redirect.destination', '/admin');
});

it('requires an origin-bound, one-use signature and keeps other wallets out of saved drafts', async () => {
  const alice = await session();
  const bob = await session();
  const load = { action: 'load' };
  expect((await request(alice.join)).status).toBe(400);
  expect((await request(load)).status).toBe(401);
  expect((await request(load, { ...alice, wallet: bob.wallet })).status).toBe(401);
  expect((await request(load, { ...alice, cookie: alice.cookie + 'a' })).status).toBe(401);
  expect((await request(load, { ...alice, origin: '' })).status).toBe(403);
  expect((await request(load, { ...alice, origin: 'https://other.example' })).status).toBe(403);
  expect((await request(load, { method: 'GET' })).status).toBe(405);
  expect((await request({ action: 'save', draft, revision: 0 }, alice)).status).toBe(200);
  expect((await request(load, bob)).data).toEqual({ draft: null, revision: 0, invites: [] });
  vi.stubEnv('NEXT_PUBLIC_NETWORK', 'mainnet-beta');
  expect((await request(load, alice)).status).toBe(401);
  vi.stubEnv('LAUNCH_PREVIEW_SECRET', '');
  expect((await request(load, alice)).status).toBe(503);
});

it('stores encrypted artwork and metadata and returns canonical fields to the owner and guests', async () => {
  const owner = await session();
  const image = await largeLaunchArtwork();
  expect(image.length).toBeGreaterThan(5_000_000);
  const largeDraft = { ...draft, tokenLogo: `data:image/png;base64,${image.toString('base64')}` };
  expect((await request({ action: 'save', draft: largeDraft, revision: 0 }, owner)).status).toBe(
    200
  );
  const { token, invite } = await createInvite(owner);
  const storageDraft = await db.query<{ ciphertext: Uint8Array }>(
    'SELECT ciphertext FROM launch_preview_drafts'
  );
  const ciphertext = Buffer.from(storageDraft.rows[0]!.ciphertext);
  for (const value of [
    draft.tokenName,
    largeDraft.tokenLogo,
    draft.tokenSymbol,
    draft.description,
    draft.sourceUrl,
  ])
    expect(ciphertext.includes(Buffer.from(value!))).toBe(false);
  const tokens = await db.query<{ token_hash: string }>(
    'SELECT token_hash FROM launch_preview_invites'
  );
  expect(tokens.rows).toEqual([{ token_hash: createHash('sha256').update(token).digest('hex') }]);

  const saved = (await request<SavedPreview>({ action: 'load' }, owner)).data;
  expect(saved.invites).toEqual([invite]);
  expect((await request({ action: 'load', includeDraft: false }, owner)).data).toEqual({
    draft: null,
    revision: 1,
    invites: [invite],
  });
  expect(saved.draft).toMatchObject({
    ...draft,
    tokenLogo: expect.stringMatching(/^data:image\/webp;base64,/),
    socials: { website: 'https://masked.example', twitter: 'https://x.com/mskdfun' },
  });
  const preview = await request<SharedPreview>({ action: 'view', token });
  expect(preview.status).toBe(200);
  expect(preview.data.draft).toEqual(saved.draft);
  expect(preview.headers.get('cache-control')).toBe('private, no-store');
  expect(preview.headers.get('referrer-policy')).toBe('no-referrer');
  expect((await request({ action: 'check', token })).data).not.toHaveProperty('draft');
  expect(
    (await request({ action: 'view', token: randomBytes(32).toString('base64url') })).status
  ).toBe(404);
});

it('enforces wallet binding, expiry, revocation and revision changes', async () => {
  const owner = await session();
  const guest = await session();
  const save = { action: 'save', draft, revision: 0 };
  const concurrent = await Promise.all([request(save, owner), request(save, owner)]);
  expect(concurrent.map(({ status }) => status).sort()).toEqual([200, 409]);
  const locked = await createInvite(owner, guest.wallet);
  const view = { action: 'view', token: locked.token };
  expect((await request(view)).status).toBe(401);
  const wrongWallet = await request(view, owner);
  expect(wrongWallet.status).toBe(401);
  expect(JSON.stringify(wrongWallet.data)).not.toContain(guest.wallet);
  expect((await request(view, guest)).status).toBe(200);
  await request({ action: 'revoke', id: locked.invite.id }, guest);
  expect((await request(view, guest)).status).toBe(200);
  await request({ action: 'revoke', id: locked.invite.id }, owner);
  expect((await request(view, guest)).status).toBe(404);

  const expiring = await createInvite(owner);
  await db.query(
    "UPDATE launch_preview_invites SET expires_at=now()-interval '1 second' WHERE id=$1",
    [expiring.invite.id]
  );
  expect((await request({ action: 'view', token: expiring.token })).status).toBe(404);
  const old = await createInvite(owner);
  expect(
    (
      await request(
        { ...save, revision: 1, draft: { ...draft, tokenName: 'Revised draft' } },
        owner
      )
    ).status
  ).toBe(200);
  expect((await request({ action: 'check', token: old.token })).status).toBe(404);
  expect(
    (await request({ action: 'invite', revision: 1, hours: 1, viewerWallet: null }, owner)).status
  ).toBe(409);
  const current = await createInvite(owner, null, 2);
  expect(
    (await request<SharedPreview>({ action: 'view', token: current.token })).data.draft.tokenName
  ).toBe('Revised draft');
  vi.stubEnv('NEXT_PUBLIC_NETWORK', 'mainnet-beta');
  expect((await request({ action: 'view', token: current.token })).status).toBe(404);
});

it('rejects unsafe artwork and links and fails closed on tampered ciphertext', async () => {
  const owner = await session();
  const save = { action: 'save', draft, revision: 0 };
  for (const bad of [
    { tokenLogo: 'data:image/png;base64,PHN2Zz48L3N2Zz4=' },
    { tokenLogo: 'https://outside.example/a.png' },
    { socials: { website: 'javascript:alert(1)' } },
  ]) {
    expect((await request({ ...save, draft: { ...draft, ...bad } }, owner)).status).toBe(400);
  }
  expect((await request(save, owner)).status).toBe(200);
  const { token } = await createInvite(owner);
  await db.exec(
    'UPDATE launch_preview_drafts SET ciphertext=set_byte(ciphertext,15,255-get_byte(ciphertext,15))'
  );
  const warning = vi.spyOn(console, 'error').mockImplementation(() => {});
  const result = await request({ action: 'view', token });
  expect(result.status).toBe(503);
  expect(warning).toHaveBeenCalledWith('Private launch preview request failed');
  expect(JSON.stringify(result.data)).not.toContain(draft.tokenName);
});
