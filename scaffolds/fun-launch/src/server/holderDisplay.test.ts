import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { Keypair, type PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, NATIVE_MINT } from '@solana/spl-token';
import type { NextApiRequest, NextApiResponse } from 'next';
import type { HoldersResponse } from '@/lib/coin';
import { vaultAddresses } from '@/lib/vault/client';
const f = vi.hoisted(() => ({
  coin: vi.fn(),
  parse: vi.fn(),
  largest: vi.fn(),
  parsed: vi.fn(),
  vaults: vi.fn(),
  migrated: vi.fn(),
  program: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock('./apiGuard', () => ({ apiGuard: () => true }));
vi.mock('./dbc', () => ({
  getCoin: f.coin,
  parseKey: f.parse,
  networkGenesis: async () => 'display-holder-test',
  connection: {
    getTokenLargestAccounts: f.largest,
    getMultipleParsedAccounts: f.parsed,
    getMultipleAccountsInfo: f.vaults,
    getMultipleAccountsInfoAndContext: f.snapshot,
  },
}));
vi.mock('./damm', () => ({ loadMigratedPool: f.migrated }));
vi.mock('./launchConfig', () => ({ configuredVaultProgram: f.program }));
import handler from '@/pages/api/coins/[mint]/holders';
import { invalidateHolders } from './holders';

const mint = Keypair.generate().publicKey,
  program = Keypair.generate().publicKey,
  dbcVault = Keypair.generate().publicKey,
  dammVault = Keypair.generate().publicKey,
  owner = Keypair.generate().publicKey,
  another = Keypair.generate().publicKey;
const custody = vaultAddresses(program, mint).tokenAccount;
const a = Keypair.generate().publicKey,
  b = Keypair.generate().publicKey,
  c = Keypair.generate().publicKey;
function token(amount: number, asset = mint, holder = owner) {
  const data = Buffer.alloc(165);
  asset.toBuffer().copy(data);
  holder.toBuffer().copy(data, 32);
  data.writeBigUInt64LE(BigInt(amount) * 1_000_000n, 64);
  data[108] = 1;
  return { data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 0 };
}
const largest = (address: PublicKey, amount: number) => ({
  address,
  amount: String(amount * 1_000_000),
  uiAmount: amount,
});
beforeEach(() => {
  invalidateHolders(mint.toBase58());
  vi.stubEnv('VAULT_PROGRAM_ID', program.toBase58());
  f.program.mockReturnValue(program);
  f.parse.mockReturnValue(mint);
  f.coin.mockResolvedValue({
    coin: {
      isMigrated: true,
      mode: 'creator',
      tokenDecimals: 6,
      tokenSupply: 1000,
      creator: owner.toBase58(),
    },
    account: { poolState: { baseVault: dbcVault } },
    config: { tokenDecimal: 6 },
  });
  f.migrated.mockResolvedValue({
    state: { tokenAMint: mint, tokenBMint: NATIVE_MINT, tokenAVault: dammVault },
  });
  f.largest.mockResolvedValue({
    context: { slot: 100 },
    value: [
      largest(dbcVault, 200),
      largest(dammVault, 300),
      largest(custody, 10),
      largest(a, 100),
      largest(b, 200),
      largest(c, 100),
    ],
  });
  f.parsed.mockResolvedValue({
    value: [owner, owner, another].map((value) => ({
      owner: TOKEN_PROGRAM_ID,
      data: { parsed: { info: { owner: value.toBase58(), mint: mint.toBase58() } } },
    })),
  });
  f.vaults.mockResolvedValue([token(200), token(300), token(10)]);
  const data = Buffer.alloc(82);
  data.writeBigUInt64LE(1000_000000n, 36);
  data[44] = 6;
  data[45] = 1;
  const values = new Map([
    [
      mint.toBase58(),
      { data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1, rentEpoch: 0 },
    ],
    [dbcVault.toBase58(), token(200)],
    [dammVault.toBase58(), token(300)],
    [custody.toBase58(), token(10)],
    [a.toBase58(), token(100)],
    [b.toBase58(), token(200)],
    [c.toBase58(), token(100, mint, another)],
  ]);
  f.snapshot.mockImplementation(async (keys: PublicKey[]) => ({
    context: { slot: 101 },
    value: keys.map((key) => values.get(key.toBase58()) ?? null),
  }));
});
afterEach(() => vi.unstubAllEnvs());
async function run() {
  let status = 0,
    body: HoldersResponse | undefined;
  const response = {
    setHeader: vi.fn(),
    status(value: number) {
      status = value;
      return response;
    },
    json(value: HoldersResponse) {
      body = value;
      return response;
    },
  };
  await handler(
    { method: 'GET', query: { mint: mint.toBase58() } } as unknown as NextApiRequest,
    response as unknown as NextApiResponse
  );
  return { status, body };
}
describe('largest-account holder sample', () => {
  it('excludes original/migrated/custody vaults, aggregates repeated owners and labels its coverage', async () => {
    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body).toMatchObject({
      circulating: 490,
      tokenSupply: 1000,
      excludedSupply: 510,
      scope: 'largest-token-accounts',
      sampledAccounts: 6,
      partial: true,
    });
    expect(body?.holders).toHaveLength(2);
    expect(body?.holders[0]).toMatchObject({
      owner: owner.toBase58(),
      amount: 300,
      isCreator: true,
      shareOfSupply: 0.3,
    });
    expect(body?.holders[0]?.shareOfCirculating).toBeCloseTo(300 / 490);
    expect(f.snapshot.mock.calls.at(-1)![1]).toMatchObject({
      commitment: 'confirmed',
      minContextSlot: 100,
    });
  });
  it('reads vault balances directly even when none appears among the largest accounts', async () => {
    f.largest.mockResolvedValue({
      context: { slot: 100 },
      value: [largest(a, 100), largest(b, 200), largest(c, 100)],
    });
    const { body } = await run();
    expect(body?.circulating).toBe(490);
    expect(body?.holders).toHaveLength(2);
    expect(f.snapshot.mock.calls.at(-1)![0]).toEqual([mint, dbcVault, dammVault, custody, a, b, c]);
  });
});
it('uses actual post-burn mint supply instead of the stale board denominator', async () => {
  const original = f.snapshot.getMockImplementation()!;
  f.snapshot.mockImplementation(async (keys: PublicKey[]) => {
    const snapshot = await original(keys);
    const mintInfo = snapshot.value[0]!;
    mintInfo.data.writeBigUInt64LE(950_000000n, 36);
    return snapshot;
  });
  const { status, body } = await run();
  expect(status).toBe(200);
  expect(body).toMatchObject({ tokenSupply: 950, circulating: 440, snapshotSlot: 101 });
  expect(body!.holders[0]!.shareOfSupply).toBeCloseTo(300 / 950);
  expect(body!.holders[0]!.shareOfCirculating).toBeCloseTo(300 / 440);
});
it('rejects a stale bank rather than mixing largest-account data with older balances', async () => {
  const original = f.snapshot.getMockImplementation()!;
  f.snapshot.mockImplementation(async (keys: PublicKey[]) => ({
    ...(await original(keys)),
    context: { slot: 99 },
  }));
  const result = await run();
  expect(result.status).toBe(200);
  expect(result.body).toMatchObject({ stale: true, snapshotSlot: 101 });
});
