import { beforeEach, expect, it, vi } from 'vitest';
import { Keypair } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import type { NextApiRequest, NextApiResponse } from 'next';
const mocks = vi.hoisted(() => ({
  getCoin: vi.fn(),
  parseKey: vi.fn(),
  largest: vi.fn(),
  parsed: vi.fn(),
  raw: vi.fn(),
  policy: vi.fn(),
  native: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock('@/server/apiGuard', () => ({ apiGuard: () => true }));
vi.mock('@/server/dbc', () => ({
  getCoin: mocks.getCoin,
  parseKey: mocks.parseKey,
  networkGenesis: async () => 'pinned-bank',
  connection: {
    getTokenLargestAccounts: mocks.largest,
    getMultipleParsedAccounts: mocks.parsed,
    getMultipleAccountsInfo: mocks.raw,
    getMultipleAccountsInfoAndContext: mocks.snapshot,
  },
}));
vi.mock('@/server/launchRegistry', () => ({ registeredConfig: mocks.policy }));
vi.mock('@/server/launchConfig', () => ({ configuredVaultProgram: mocks.native }));
import handler from '@/pages/api/coins/[mint]/holders';
import { invalidateHolders } from './holders';
const mint = Keypair.generate().publicKey,
  collector = Keypair.generate().publicKey,
  baseVault = Keypair.generate().publicKey,
  holderAta = Keypair.generate().publicKey;
const collectorAta = getAssociatedTokenAddressSync(mint, collector);
const actualHolder = Keypair.generate().publicKey;
beforeEach(() => {
  vi.resetAllMocks();
  invalidateHolders(mint.toBase58());
  vi.stubEnv('VAULT_PROGRAM_ID', '');
  mocks.parseKey.mockReturnValue(mint);
  mocks.getCoin.mockResolvedValue({
    account: { poolState: { baseVault } },
    coin: {
      mode: 'creator',
      feePolicyVersion: 'wallet-v1',
      configKey: 'immutable-config',
      tokenDecimals: 6,
      tokenSupply: 10,
      creator: 'creator',
    },
    config: { tokenDecimal: 6 },
  });
  mocks.policy.mockResolvedValue({
    policy_version: 'wallet-v1',
    expected_fee_claimer: collector.toBase58(),
  });
  mocks.native.mockImplementation(() => {
    throw Error('A custom vault is not configured');
  });
  mocks.largest.mockResolvedValue({
    context: { slot: 100 },
    value: [
      { address: collectorAta, amount: '2000000' },
      { address: holderAta, amount: '1000000' },
    ],
  });
  mocks.parsed.mockResolvedValue({
    value: [
      {
        owner: TOKEN_PROGRAM_ID,
        data: { parsed: { info: { mint: mint.toBase58(), owner: 'actual-holder' } } },
      },
    ],
  });
  mocks.raw.mockResolvedValue([null, null]);
  const mintData = Buffer.alloc(82);
  mintData.writeBigUInt64LE(10_000000n, 36);
  mintData[44] = 6;
  mintData[45] = 1;
  const token = (value: bigint, owner = actualHolder) => {
    const data = Buffer.alloc(165);
    mint.toBuffer().copy(data);
    owner.toBuffer().copy(data, 32);
    data.writeBigUInt64LE(value, 64);
    data[108] = 1;
    return data;
  };
  mocks.snapshot.mockImplementation(async (keys: (typeof mint)[]) => ({
    context: { slot: 101 },
    value: keys.map((key) => {
      const data = key.equals(mint)
        ? mintData
        : key.equals(collectorAta)
          ? token(2_000000n, collector)
          : key.equals(holderAta)
            ? token(1_000000n)
            : null;
      return data
        ? { data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 0 }
        : null;
    }),
  }));
});
async function call() {
  let status = 200,
    body: unknown;
  const response = {
    setHeader() {},
    status(code: number) {
      status = code;
      return this;
    },
    json(value: unknown) {
      body = value;
      return this;
    },
  };
  await handler(
    { method: 'GET', query: { mint: mint.toBase58() } } as unknown as NextApiRequest,
    response as unknown as NextApiResponse
  );
  return { status, body };
}
it('excludes the immutable company collector ATA without any custom vault environment', async () => {
  const result = await call();
  expect(result.status).toBe(200);
  expect(mocks.snapshot.mock.calls[0]![0]).toEqual([mint, baseVault, collectorAta, holderAta]);
  expect(mocks.policy).toHaveBeenCalledWith('pinned-bank', 'immutable-config');
  expect(mocks.native).not.toHaveBeenCalled();
  expect(result.body).toMatchObject({
    holders: [{ owner: actualHolder.toBase58(), amount: 1 }],
    excludedSupply: 2,
  });
});
it('fails closed if the immutable collector policy is missing instead of guessing a wallet', async () => {
  mocks.policy.mockResolvedValue(null);
  expect((await call()).status).toBe(503);
  expect(mocks.largest).not.toHaveBeenCalled();
  expect(mocks.native).not.toHaveBeenCalled();
});
it('a warm display cache cannot bypass a missing immutable collector policy', async () => {
  expect((await call()).status).toBe(200);
  const reads = mocks.largest.mock.calls.length;
  mocks.policy.mockResolvedValue(null);
  expect((await call()).status).toBe(503);
  expect(mocks.largest).toHaveBeenCalledTimes(reads);
  expect(mocks.native).not.toHaveBeenCalled();
});
