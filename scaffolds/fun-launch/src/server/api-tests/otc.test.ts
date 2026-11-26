import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';
import type { NextApiRequest, NextApiResponse } from 'next';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { assertSocialChallenge, type SocialChallenge } from '@/lib/profiles';
import { NETWORK_GENESIS } from '@/server/launchConfig';
import {
  normalizeOtcAmount,
  otcAcceptanceMessage,
  type OtcTerms,
  type OwnedOtcOffer,
  type ViewedOtcOffer,
} from '@/lib/otc';
import handler from '@/pages/api/otc';
import ringsHandler from '@/pages/api/otc-rings';
import ringsRpcHandler from '@/pages/api/otc-rings-rpc';
import { getServerSideProps } from '@/pages/otc';
import { walletFixture } from './walletFixture';
import { rehearseRingsDesk } from './otcRingsRehearsal';

const storage = vi.hoisted(() => ({ query: vi.fn(), connect: vi.fn() }));
vi.mock('@/server/database', () => ({ database: () => storage }));

const origin = 'https://otc.example';
const cookieName = '__Host-mskd_otc';
const terms = {
  sell: { asset: 'SOL', amount: '1.000' },
  buy: { asset: 'USDC', amount: '124.5000' },
};
const canonicalTerms: OtcTerms = {
  sell: { asset: 'SOL', amount: '1' },
  buy: { asset: 'USDC', amount: '124.5' },
};
let db: PGlite;
let requestIp = 0;

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
    '031-confidential-otc-offers.sql',
    '032-otc-rings-deals.sql',
  ]) {
    await db.exec(
      readFileSync(new URL(`../../../../../scripts/migrations/${file}`, import.meta.url), 'utf8')
    );
  }
  storage.query.mockImplementation((sql: string, params?: unknown[]) => db.query(sql, params));
  storage.connect.mockResolvedValue({ query: storage.query, release: () => {} });
}, 20_000);

beforeEach(async () => {
  requestIp += 1;
  vi.stubEnv('LAUNCHPAD_PUBLIC', 'true');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', origin);
  vi.stubEnv('NEXT_PUBLIC_NETWORK', 'devnet');
  vi.stubEnv('OTC_MAINNET_OFFERS_ENABLED', undefined);
  vi.stubEnv('DATABASE_URL', 'postgresql://fixture');
  vi.stubEnv('OTC_PREVIEW_SECRET', 'd5'.repeat(32));
  await db.exec(
    'TRUNCATE wallet_social_challenges,wallet_social_limits,confidential_otc_offers CASCADE'
  );
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});
afterAll(() => db.close());

type Context = { wallet?: string; cookie?: string; origin?: string };
async function request<T = unknown>(body: object, options: Context = {}, path = '/api/otc') {
  const headers = new Map<string, string>();
  const status = vi.fn().mockReturnThis();
  const json = vi.fn();
  const route =
    path === '/api/otc-rings'
      ? ringsHandler
      : path === '/api/otc-rings-rpc'
        ? ringsRpcHandler
        : handler;
  await route(
    {
      method: 'POST',
      url: path,
      headers: {
        origin: options.origin ?? origin,
        'content-type': 'application/json',
        'x-otc-wallet': options.wallet,
      },
      cookies: { [cookieName]: options.cookie },
      socket: { remoteAddress: `192.0.2.${requestIp}` },
      body,
    } as unknown as NextApiRequest,
    {
      setHeader: (key: string, value: string) => headers.set(key.toLowerCase(), value),
      status,
      json,
      send: json,
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

async function connect(user = walletFixture()) {
  const { wallet } = user;
  const seed = await request<SocialChallenge>({ action: 'challenge', wallet });
  expect(seed.status).toBe(200);
  assertSocialChallenge(seed.data, origin, wallet, 'otc', null);
  const join = {
    action: 'join',
    wallet,
    nonce: seed.data.nonce,
    signature: user.sign(seed.data.message),
  };
  const signed = await request(join);
  expect(signed.status).toBe(200);
  expect(signed.headers.get('set-cookie')).toContain('HttpOnly; Secure; SameSite=Strict; Path=/');
  return { wallet, cookie: signed.cookie, join };
}

it.runIf(process.env.OTC_RINGS_LOCALNET === '1')(
  'funds, settles and withdraws through the OTC and Rings gateway routes',
  async () => {
    await rehearseRingsDesk(request);
  },
  120_000
);

it.runIf(process.env.OTC_RINGS_LOCALNET === '1').each([
  { quote: 'USDC', token2022: false },
  { quote: 'SOL', token2022: true },
] as const)(
  'registers, funds, settles and withdraws a launch token against $quote (Token-2022: $token2022)',
  async (pair) => {
    await rehearseRingsDesk(request, {
      ...pair,
      register: (genesis, mint) =>
        db.query('INSERT INTO launch_coins (network_genesis,mint) VALUES ($1,$2)', [genesis, mint]),
    });
  },
  120_000
);

it('restricts saved settlement rooms to both wallets and keeps the room after a reload or expiry', async () => {
  vi.stubEnv('OTC_RINGS_SETTLEMENT_ENABLED', 'true');
  vi.stubEnv('OTC_RINGS_RPC_URL', 'https://devnet.helius-rpc.com/?api-key=fixture');
  const owner = await connect();
  const buyer = walletFixture();
  const taker = await connect(buyer);
  const third = await connect();
  const { token, offer } = await create(owner, buyer.wallet);
  const id = offer.id;
  const route = '/api/otc-rings';
  expect((await request({ action: 'open', id }, owner, route)).status).toBe(404);
  expect((await request(await signedAgreement(token, buyer, taker), taker)).status).toBe(200);
  expect((await request({ action: 'open', id }, third, route)).status).toBe(404);
  const opened = await request({ action: 'open', id }, owner, route);
  expect(opened.status).toBe(200);
  expect(opened.data).toMatchObject({ id, side: 'maker', terms: canonicalTerms });
  expect((await request({ action: 'view', id }, taker, route)).data).toMatchObject({
    id,
    side: 'taker',
  });
  expect((await request({ action: 'view', id }, third, route)).status).toBe(404);
  expect((await request({ action: 'revoke', id }, owner)).status).toBe(409);
  vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16 * 60_000);
  vi.stubEnv('OTC_RINGS_SETTLEMENT_ENABLED', 'false');
  expect((await request({ action: 'attempt', id }, owner, route)).status).toBe(409);
  expect((await request({ action: 'view', id }, taker, route)).status).toBe(200);
  expect((await request({ action: 'list' }, taker, route)).data).toMatchObject([
    { id, side: 'taker' },
  ]);
});

async function create(owner: Context, viewerWallet: string | null = null) {
  const result = await request<{ token: string; offer: OwnedOtcOffer }>(
    { action: 'create', terms, minutes: 15, viewerWallet },
    owner
  );
  expect(result.status).toBe(200);
  return result.data;
}

async function signedAgreement(
  token: string,
  signer: ReturnType<typeof walletFixture>,
  viewer: Context,
  changes: Partial<ViewedOtcOffer> = {}
) {
  const viewed = await request<ViewedOtcOffer>({ action: 'view', token }, viewer);
  expect(viewed.status).toBe(200);
  const offer = { ...viewed.data, ...changes };
  const message = await otcAcceptanceMessage(token, signer.wallet, origin, offer.genesis, offer);
  return { action: 'accept', token, signature: signer.sign(message) };
}

it('validates amounts exactly to each asset precision and rejects zero and overflow', () => {
  expect(normalizeOtcAmount('SOL', '0.000000001')).toBe('0.000000001');
  expect(normalizeOtcAmount('USDC', '0.0000001')).toBeNull();
  expect(normalizeOtcAmount('SOL', '18446744073.709551615')).toBe('18446744073.709551615');
  expect(normalizeOtcAmount('SOL', '18446744073.709551616')).toBeNull();
  for (const input of ['0.000000000', '01', '1e3', '-1', '1.'])
    expect(normalizeOtcAmount('SOL', input)).toBeNull();
});

it('requires an explicit mainnet opt-in and keeps private site admission in place', async () => {
  const setHeader = vi.fn();
  const context = {
    req: { cookies: {} },
    res: { setHeader },
    resolvedUrl: '/otc',
    query: { offer: 'ignored' },
  } as unknown as Parameters<typeof getServerSideProps>[0];
  expect(await getServerSideProps(context)).toEqual({ props: { mode: 'test' } });
  expect(setHeader).toHaveBeenCalledWith('Cache-Control', 'private, no-store');
  expect(setHeader).toHaveBeenCalledWith('X-Robots-Tag', 'noindex, nofollow, noarchive');
  vi.stubEnv('LAUNCHPAD_PUBLIC', 'false');
  expect(await getServerSideProps(context)).toHaveProperty('redirect.destination', '/admin');
  expect((await request({ action: 'list' })).status).toBe(401);
  vi.stubEnv('LAUNCHPAD_PUBLIC', 'true');
  vi.stubEnv('NEXT_PUBLIC_NETWORK', 'mainnet-beta');
  const challenge = { action: 'challenge', wallet: walletFixture().wallet };
  for (const flag of [undefined, 'false', 'TRUE']) {
    vi.stubEnv('OTC_MAINNET_OFFERS_ENABLED', flag);
    expect(await getServerSideProps(context)).toEqual({ props: { mode: null } });
    expect((await request(challenge)).status).toBe(404);
  }

  vi.stubEnv('OTC_MAINNET_OFFERS_ENABLED', 'true');
  expect(await getServerSideProps(context)).toEqual({ props: { mode: 'mainnet' } });
  vi.stubEnv('LAUNCHPAD_PUBLIC', 'false');
  expect(await getServerSideProps(context)).toHaveProperty('redirect.destination', '/admin');
  expect((await request(challenge)).status).toBe(401);
  vi.stubEnv('LAUNCHPAD_PUBLIC', 'true');
  vi.stubEnv('DATABASE_URL', 'invalid');
  expect((await request(challenge)).status).toBe(404);
  vi.stubEnv('DATABASE_URL', 'postgresql://fixture');
  vi.stubEnv('OTC_PREVIEW_SECRET', 'invalid');
  expect((await request(challenge)).status).toBe(404);
});

it('records a mainnet agreement off-chain and isolates it from devnet sessions and offers', async () => {
  const maker = walletFixture();
  const taker = walletFixture();
  const testSession = await connect(maker);
  const testOffer = await create(testSession);
  vi.stubEnv('NEXT_PUBLIC_NETWORK', 'mainnet-beta');
  vi.stubEnv('OTC_MAINNET_OFFERS_ENABLED', 'true');

  expect((await request({ action: 'list' }, testSession)).status).toBe(401);
  expect((await request({ action: 'view', token: testOffer.token })).status).toBe(404);
  const owner = await connect(maker);
  const viewer = await connect(taker);
  expect((await request({ action: 'list' }, owner)).data).toEqual({ offers: [] });
  const { token } = await create(owner, viewer.wallet);
  const action = { action: 'view', token };
  const view = await request<ViewedOtcOffer>(action, viewer);
  expect(view.status).toBe(200);
  expect(view.headers.get('cache-control')).toBe('private, no-store');
  expect(view.data.genesis).toBe(NETWORK_GENESIS['mainnet-beta']);
  const message = await otcAcceptanceMessage(
    token,
    viewer.wallet,
    origin,
    view.data.genesis,
    view.data
  );
  expect(message).toContain('Agree to off-chain OTC offer');
  expect(message).toContain('It cannot move funds.');

  const devnetAgreement = await signedAgreement(token, taker, viewer, {
    genesis: NETWORK_GENESIS.devnet,
  });
  expect((await request(devnetAgreement, viewer)).status).toBe(403);
  const accepted = await request<ViewedOtcOffer>(
    { action: 'accept', token, signature: taker.sign(message) },
    viewer
  );
  expect(accepted.data.status).toBe('accepted');
  expect((await request({ action: 'settle', token }, viewer)).status).toBe(400);

  vi.stubEnv('NEXT_PUBLIC_NETWORK', 'devnet');
  expect((await request(action)).status).toBe(404);
  expect((await request({ action: 'list' }, owner)).status).toBe(401);
});

it('requires an origin and wallet-bound session for maker actions and validates each leg', async () => {
  const owner = await connect();
  const outsider = await connect();
  const payload = { action: 'create', terms, minutes: 15, viewerWallet: null as string | null };
  expect((await request(owner.join)).status).toBe(400);
  expect((await request(payload)).status).toBe(401);
  expect((await request(payload, { ...owner, wallet: outsider.wallet })).status).toBe(401);
  expect((await request(payload, { ...owner, origin: '' })).status).toBe(403);
  expect((await request({ ...payload, viewerWallet: owner.wallet }, owner)).status).toBe(400);
  expect((await request({ ...payload, terms: { ...terms, buy: terms.sell } }, owner)).status).toBe(
    400
  );
  expect((await request({ ...payload, minutes: 5 }, owner)).status).toBe(400);
  expect(
    (
      await request(
        { ...payload, terms: { ...terms, buy: { asset: 'USDC', amount: '0.0000001' } } },
        owner
      )
    ).status
  ).toBe(400);
  expect((await request({ action: 'settle', token: 'a'.repeat(43) }, owner)).status).toBe(400);
});

it('stores encrypted terms and token hashes, returning only the terms and expiry to guests', async () => {
  const owner = await connect();
  const { token, offer } = await create(owner);
  const result = await db.query<{ ciphertext: Uint8Array; token_hash: string }>(
    'SELECT ciphertext,token_hash FROM confidential_otc_offers'
  );
  expect(result.rows[0]!.token_hash).toBe(createHash('sha256').update(token).digest('hex'));
  expect(Buffer.from(result.rows[0]!.ciphertext).includes(Buffer.from('124.5'))).toBe(false);
  const guest = await request<ViewedOtcOffer>({ action: 'view', token });
  expect(guest.status).toBe(200);
  expect(guest.headers.get('cache-control')).toBe('private, no-store');
  expect(guest.headers.get('referrer-policy')).toBe('no-referrer');
  expect(guest.data).toEqual({
    terms: canonicalTerms,
    expiresAt: offer.expiresAt,
    expiresInMs: expect.any(Number),
    genesis: 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
    status: 'open',
    canAccept: false,
  });
  expect((await request({ action: 'list' }, owner)).data).toEqual({ offers: [offer] });
  expect(JSON.stringify((await request({ action: 'list' }, owner)).data)).not.toContain(token);
});

it('rejects the wrong wallet and enforces expiry and revocation', async () => {
  const owner = await connect();
  const viewer = await connect();
  const wrong = await connect();
  const { token, offer } = await create(owner, viewer.wallet);
  const view = { action: 'view', token };
  const revoke = { action: 'revoke', id: offer.id };
  expect((await request(view)).status).toBe(401);
  const denied = await request(view, wrong);
  expect(denied.status).toBe(401);
  expect(JSON.stringify(denied.data)).not.toContain(viewer.wallet);
  expect((await request(view, viewer)).status).toBe(200);
  expect((await request({ action: 'list' }, viewer)).data).toEqual({ offers: [] });
  expect((await request(revoke, viewer)).status).toBe(200);
  expect((await request(view, viewer)).status).toBe(200);
  expect((await request(revoke, owner)).status).toBe(200);
  expect((await request(view, viewer)).status).toBe(404);

  const expiring = await create(owner);
  await db.query(
    "UPDATE confidential_otc_offers SET expires_at=now()-interval '1 second' WHERE id=$1",
    [expiring.offer.id]
  );
  expect((await request({ action: 'view', token: expiring.token })).status).toBe(404);
  expect((await request({ action: 'list' }, owner)).data).toEqual({ offers: [] });
});

it('binds an agreement to the test network, exact offer and invited wallet', async () => {
  const maker = walletFixture();
  const owner = await connect(maker);
  const taker = walletFixture();
  const buyer = await connect(taker);
  const outsider = await connect();
  const { token, offer } = await create(owner, buyer.wallet);
  const agree = await signedAgreement(token, taker, buyer);
  const wrongTerms = await signedAgreement(token, taker, buyer, {
    terms: { ...canonicalTerms, buy: { asset: 'USDC', amount: '124' } },
  });
  const wrongGenesis = await signedAgreement(token, taker, buyer, { genesis: 'wrong-network' });
  expect((await request(agree)).status).toBe(401);
  expect((await request(agree, outsider)).status).toBe(401);
  expect((await request(wrongTerms, buyer)).status).toBe(403);
  expect((await request(wrongGenesis, buyer)).status).toBe(403);
  const other = await create(owner, buyer.wallet);
  expect((await request({ ...agree, token: other.token }, buyer)).status).toBe(403);
  const anonymous = await create(owner);
  expect((await request(await signedAgreement(anonymous.token, maker, owner), owner)).status).toBe(
    400
  );
  const accepted = await request<ViewedOtcOffer>(agree, buyer);
  expect(accepted.status).toBe(200);
  expect(accepted.data).toMatchObject({
    terms: canonicalTerms,
    status: 'accepted',
    canAccept: false,
  });
  const reported = await request<{ offers: OwnedOtcOffer[] }>({ action: 'list' }, owner);
  expect(reported.data.offers.find(({ id }) => id === offer.id)?.accepted).toBe(true);
  expect(JSON.stringify(reported.data)).not.toContain(agree.signature);
  const stored = await db.query<{ ciphertext: Uint8Array }>(
    'SELECT ciphertext FROM confidential_otc_offers WHERE id=$1',
    [offer.id]
  );
  expect(Buffer.from(stored.rows[0]!.ciphertext).includes(Buffer.from(agree.signature))).toBe(
    false
  );
});

it('records one counterparty under concurrent acceptance and survives a retry', async () => {
  const owner = await connect();
  const firstSigner = walletFixture();
  const secondSigner = walletFixture();
  const first = await connect(firstSigner);
  const second = await connect(secondSigner);
  const { token } = await create(owner);
  const [firstAction, secondAction] = await Promise.all([
    signedAgreement(token, firstSigner, first),
    signedAgreement(token, secondSigner, second),
  ]);
  const results = await Promise.all([request(firstAction, first), request(secondAction, second)]);
  expect(results.map(({ status }) => status).sort()).toEqual([200, 409]);
  const [action, buyer] =
    results[0].status === 200 ? ([firstAction, first] as const) : ([secondAction, second] as const);
  const retried = await request<ViewedOtcOffer>(action, buyer);
  expect(retried.status).toBe(200);
  expect(retried.data.status).toBe('accepted');
  const guest = await request<ViewedOtcOffer>({ action: 'view', token });
  expect(guest.data).toMatchObject({ status: 'reserved', canAccept: false });
  const response = JSON.stringify(guest.data);
  expect(response).not.toContain(first.wallet);
  expect(response).not.toContain(second.wallet);
});

it.each([false, true])('recovers a failed database response, committed=%s', async (committed) => {
  const owner = await connect();
  const signer = walletFixture();
  const buyer = await connect(signer);
  const { token } = await create(owner);
  const agree = await signedAgreement(token, signer, buyer);
  const query = storage.query.getMockImplementation()!;
  vi.spyOn(console, 'error').mockImplementation(() => {});
  storage.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/^UPDATE confidential_otc_offers SET ciphertext/.test(sql)) {
      storage.query.mockImplementation(query);
      if (committed) await query(sql, params);
      throw new Error('Simulated database connection failure');
    }
    return query(sql, params);
  });
  expect((await request(agree, buyer)).status).toBe(503);
  const view = await request<ViewedOtcOffer>({ action: 'view', token }, buyer);
  expect(view.data.status).toBe(committed ? 'accepted' : 'open');
  expect((await request(agree, buyer)).status).toBe(200);
});

it.each(['expiry', 'revocation'])('cannot accept an offer after %s', async (event) => {
  const owner = await connect();
  const signer = walletFixture();
  const buyer = await connect(signer);
  const { token, offer } = await create(owner);
  const agree = await signedAgreement(token, signer, buyer);
  const query = storage.query.getMockImplementation()!;
  storage.query.mockImplementation(async (sql: string, params?: unknown[]) => {
    if (/^UPDATE confidential_otc_offers SET ciphertext/.test(sql)) {
      storage.query.mockImplementation(query);
      if (event === 'expiry')
        await db.query(
          "UPDATE confidential_otc_offers SET expires_at=now()-interval '1 second' WHERE id=$1",
          [offer.id]
        );
      else await db.query('DELETE FROM confidential_otc_offers WHERE id=$1', [offer.id]);
    }
    return query(sql, params);
  });
  expect((await request(agree, buyer)).status).toBe(404);
  expect((await request(agree, buyer)).status).toBe(404);
});

it('fails closed when encrypted offer data is tampered with', async () => {
  const owner = await connect();
  const { token } = await create(owner);
  await db.exec(
    'UPDATE confidential_otc_offers SET ciphertext=set_byte(ciphertext,15,255-get_byte(ciphertext,15))'
  );
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const response = await request({ action: 'view', token });
  expect(response.status).toBe(503);
  expect(JSON.stringify(response.data)).not.toContain('124.5');
});
