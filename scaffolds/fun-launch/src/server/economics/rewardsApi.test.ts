import { beforeEach, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import type { NextApiRequest, NextApiResponse } from 'next';
import { claimAuthorizationMessage, type ClaimAuthorization } from '@/lib/rewards';
const mocks = vi.hoisted(() => ({
  job: vi.fn(),
  view: vi.fn(),
  request: vi.fn(),
  lookup: vi.fn(),
  genesis: vi.fn(),
  coin: vi.fn(),
  limit: vi.fn(),
  gate: vi.fn(),
  account: vi.fn(),
  rent: vi.fn(),
}));
vi.mock('@/server/apiGuard', () => ({ apiGuard: () => true, takeLimit: mocks.limit }));
vi.mock('@/server/economics/walletGate', () => ({ assertWalletExecutionGate: mocks.gate }));
vi.mock('@/server/dbc', () => ({
  networkGenesis: mocks.genesis,
  connection: { getAccountInfo: mocks.account, getMinimumBalanceForRentExemption: mocks.rent },
}));
vi.mock('@/server/siteOrigin', () => ({ siteOriginForHeaders: () => 'https://launch.example' }));
vi.mock('@/server/launchRegistry', () => ({ registeredCoin: mocks.coin }));
vi.mock('@/server/economics/walletStore', () => ({
  WalletStore: class {
    job = mocks.job;
    rewardsView = mocks.view;
    requestClaim = mocks.request;
    payoutForRequest = mocks.lookup;
  },
}));
import handler from '@/pages/api/rewards';
const keys = generateKeyPairSync('ed25519'),
  wallet = new PublicKey(
    keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
  ).toBase58();
const genesis = 'EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG',
  mint = new PublicKey(new Uint8Array(32).fill(7)).toBase58();
const id = '12345678-1234-4234-9234-123456789abc';
const payout = {
  id,
  network_genesis: genesis,
  mint,
  kind: 'creator_claim',
  recipient: wallet,
  status: 'queued',
  signature: null as string | null,
  lamports: '100',
  transaction_base64: 'PRIVATE-WIRE-BYTES',
  message_digest: 'private-digest',
  last_valid_block_height: '100',
};
function authorization(patch: Partial<ClaimAuthorization> = {}) {
  const input: ClaimAuthorization = {
    networkGenesis: genesis,
    mint,
    wallet,
    epoch: null,
    amount: '100',
    requestId: id,
    issuedAt: Date.now(),
    ...patch,
  };
  return {
    ...input,
    signature: sign(
      null,
      Buffer.from(claimAuthorizationMessage('https://launch.example', input)),
      keys.privateKey
    ).toString('base64'),
  };
}
beforeEach(() => {
  vi.resetAllMocks();
  mocks.genesis.mockResolvedValue(genesis);
  mocks.limit.mockReturnValue(true);
  mocks.gate.mockResolvedValue(undefined);
  mocks.account.mockResolvedValue({
    lamports: 1_000_000,
    executable: false,
    data: Buffer.alloc(0),
  });
  mocks.rent.mockResolvedValue(890_880);
  mocks.coin.mockResolvedValue({
    mint,
    mode: 'creator',
    original_deployer: wallet,
    policy_version: 'wallet-v1',
  });
  mocks.job.mockResolvedValue(payout);
  mocks.request.mockResolvedValue(payout);
  mocks.lookup.mockResolvedValue(payout);
  mocks.view.mockResolvedValue({
    mode: 'creator',
    availableLamports: '100',
    paidLamports: '0',
    epochs: [],
    pendingPayout: payout,
    receipts: [],
  });
});
it('rejects tiny payouts to absent or below-rent recipients before reserving an immutable job', async () => {
  for (const account of [null, { lamports: 890_000, executable: false, data: Buffer.alloc(0) }]) {
    mocks.account.mockResolvedValueOnce(account);
    const result = await call('POST', { action: 'prepare', ...authorization() });
    expect(result.code).toBe(400);
    expect(result.body.requestAccepted).toBe(false);
  }
  expect(mocks.request).not.toHaveBeenCalled();
  mocks.account.mockResolvedValueOnce({
    lamports: 890_800,
    executable: false,
    data: Buffer.alloc(0),
  });
  expect((await call('POST', { action: 'prepare', ...authorization() })).code).toBe(202);
  expect(mocks.request).toHaveBeenCalledOnce();
});
it('marks failed pre-reservation RPC reads unaccepted and withholds provider details', async () => {
  mocks.account.mockRejectedValueOnce(new Error('https://private.provider/?key=DO_NOT_DISCLOSE'));
  const result = await call('POST', { action: 'prepare', ...authorization() });
  expect(result.code).toBe(503);
  expect(result.body.requestAccepted).toBe(false);
  expect(JSON.stringify(result.body)).not.toContain('DO_NOT_DISCLOSE');
  expect(mocks.request).not.toHaveBeenCalled();
});
it('keeps existing status readable during a pause and marks rejected new requests unaccepted', async () => {
  mocks.gate.mockRejectedValue(new Error('Execution disabled'));
  const rejected = await call('POST', { action: 'prepare', ...authorization() });
  expect(rejected.code).toBe(503);
  expect(rejected.body.requestAccepted).toBe(false);
  expect(mocks.request).not.toHaveBeenCalled();
  const status = await call('POST', {
    action: 'settle',
    id,
    networkGenesis: genesis,
    mint,
    wallet,
  });
  expect(status.code).toBe(202);
  expect(mocks.gate).toHaveBeenCalledTimes(1);
});
async function call(method: string, body: object = {}, query: object = {}) {
  let code = 200,
    result: Record<string, unknown> = {};
  const response = {
    setHeader() {},
    status(value: number) {
      code = value;
      return this;
    },
    json(value: Record<string, unknown>) {
      result = value;
      return this;
    },
  };
  await handler(
    { method, body, query, headers: {} } as NextApiRequest,
    response as unknown as NextApiResponse
  );
  return { code, body: result };
}
it('queues a signed exact-wallet request and exposes only its public pending receipt', async () => {
  const result = await call('POST', { action: 'prepare', ...authorization() });
  expect(result.code).toBe(202);
  expect(result.body).toEqual({
    id,
    status: 'queued',
    signature: null,
    amount: '100',
    requestId: id,
  });
  expect(mocks.request).toHaveBeenCalledWith({
    networkGenesis: genesis,
    mint,
    wallet,
    epoch: null,
    amount: 100n,
    requestId: id,
    authorizationDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
  });
  expect(JSON.stringify(result.body)).not.toMatch(/PRIVATE|transaction|digest|block_height/);
  expect(mocks.genesis).toHaveBeenCalledWith(true);
});
it('rejects a changed signed amount, stale authorization and free-form recipient or signed transaction', async () => {
  const signed = authorization();
  expect((await call('POST', { action: 'prepare', ...signed, amount: '101' })).code).toBe(401);
  expect(
    (await call('POST', { action: 'prepare', ...authorization({ issuedAt: Date.now() - 300001 }) }))
      .code
  ).toBe(401);
  expect((await call('POST', { action: 'prepare', ...signed, recipient: mint })).code).toBe(400);
  expect((await call('POST', { action: 'submit', id, signedTransaction: 'anything' })).code).toBe(
    400
  );
  expect(mocks.request).not.toHaveBeenCalled();
});
it('enforces original creator, hourly epoch and request throttles before reserving cash', async () => {
  mocks.coin.mockResolvedValueOnce({
    mint,
    mode: 'creator',
    original_deployer: mint,
    policy_version: 'wallet-v1',
  });
  expect((await call('POST', { action: 'prepare', ...authorization() })).code).toBe(403);
  mocks.coin.mockResolvedValueOnce({ mint, mode: 'community', policy_version: 'wallet-v1' });
  expect((await call('POST', { action: 'prepare', ...authorization() })).code).toBe(400);
  mocks.limit.mockReturnValue(false);
  expect((await call('POST', { action: 'prepare', ...authorization() })).code).toBe(429);
  expect(mocks.request).not.toHaveBeenCalled();
});
it('rechecks network immediately before the atomic reservation and fails closed on unavailable balances', async () => {
  mocks.genesis.mockResolvedValueOnce(genesis).mockResolvedValueOnce(mint);
  expect((await call('POST', { action: 'prepare', ...authorization() })).code).toBe(409);
  expect(mocks.request).not.toHaveBeenCalled();
  mocks.genesis.mockResolvedValue(genesis);
  mocks.request.mockRejectedValue(new Error('Insufficient funded reward'));
  const result = await call('POST', { action: 'prepare', ...authorization() });
  expect(result.code).toBe(503);
  expect(result.body).not.toHaveProperty('status', 'finalized');
});
it('recovers a lost POST by immutable request ID and never returns private transaction bytes', async () => {
  const result = await call('GET', {}, { mint, wallet, requestId: id });
  expect(result.code).toBe(200);
  expect(mocks.lookup).toHaveBeenCalledWith(genesis, mint, wallet, id);
  expect(result.body.request).toEqual({
    id,
    status: 'queued',
    signature: null,
    amount: '100',
    requestId: id,
  });
  expect(result.body.payoutMethod).toBe('server-paid');
  expect(JSON.stringify(result.body)).not.toMatch(/PRIVATE|transaction_base64|claimAccountFunding/);
  expect(mocks.request).not.toHaveBeenCalled();
});
it('status checks cannot execute a payout and only report finalized after the worker records it', async () => {
  const body = { action: 'settle', id, networkGenesis: genesis, mint, wallet };
  expect((await call('POST', body)).code).toBe(202);
  mocks.job.mockResolvedValueOnce({
    ...payout,
    status: 'finalized',
    signature: 'public-finalized-receipt',
  });
  expect((await call('POST', body)).body).toMatchObject({
    status: 'finalized',
    signature: 'public-finalized-receipt',
  });
  mocks.job.mockResolvedValueOnce({ ...payout, recipient: mint });
  expect((await call('POST', body)).code).toBe(404);
  expect(mocks.request).not.toHaveBeenCalled();
});
it('keeps non-wallet policies unavailable without requiring a custom vault deployment', async () => {
  mocks.coin.mockResolvedValueOnce({ mode: 'community', policy_version: 'rinse-v1' });
  const result = await call('GET', {}, { mint, wallet });
  expect(result.code).toBe(200);
  expect(result.body.status).toBe('unavailable');
  expect(mocks.view).not.toHaveBeenCalled();
});
it('bounds Community pages and sums only the displayed available hourly rewards', async () => {
  mocks.coin.mockResolvedValue({ mint, mode: 'community', policy_version: 'wallet-v1' });
  mocks.view.mockResolvedValue({
    mode: 'community',
    availableLamports: '1099',
    paidLamports: '0',
    pendingPayout: null,
    receipts: [],
    epochs: Array.from({ length: 11 }, (_, index) => ({
      epoch: String(100 - index),
      lamports: index === 10 ? '999' : '10',
      status: 'available',
      jobId: null as string | null,
    })),
  });
  const result = await call('GET', {}, { mint, wallet });
  expect(result.body.availableLamports).toBe('100');
  expect(result.body.epochs).toHaveLength(10);
  expect(result.body.nextEpoch).toBe('91');
  expect(mocks.view).toHaveBeenCalledWith({ networkGenesis: genesis, mint, wallet, limit: 11 });
});
