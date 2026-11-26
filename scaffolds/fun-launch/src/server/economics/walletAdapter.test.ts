import { beforeEach, expect, it, vi } from 'vitest';
import { DYNAMIC_BONDING_CURVE_PROGRAM_ID } from '@meteora-ag/dynamic-bonding-curve-sdk';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, getAssociatedTokenAddressSync } from '@solana/spl-token';
import { Keypair, type Connection } from '@solana/web3.js';
import { MeteoraWalletAdapter } from './walletAdapter';
import type { RegisteredCoin } from '../launchRegistry';

const mocks = vi.hoisted(() => ({
  registered: vi.fn(),
  gate: vi.fn(),
  config: vi.fn(),
  pool: vi.fn(),
}));
vi.mock('@meteora-ag/dynamic-bonding-curve-sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@meteora-ag/dynamic-bonding-curve-sdk')>()),
  DynamicBondingCurveClient: class {
    state = { getPoolConfig: mocks.config, getPool: mocks.pool };
  },
}));
vi.mock('../launchRegistry', () => ({ registeredCoin: mocks.registered }));
vi.mock('../launchConfig', () => ({ verifyConfigAccount: vi.fn(), verifyLaunchConfig: vi.fn() }));
vi.mock('./walletGate', () => ({ assertWalletExecutionGate: mocks.gate }));
vi.mock('./walletOperatingCosts', () => ({
  walletOperatingCosts: vi.fn().mockResolvedValue({
    operatingCostLamports: 10_000n,
    temporaryFundingLamports: 0n,
  }),
}));

const collector = Keypair.generate().publicKey;
const mint = Keypair.generate().publicKey;
const pool = Keypair.generate().publicKey;
const config = Keypair.generate().publicKey;
const coin: RegisteredCoin = {
  network_genesis: 'genesis',
  mint: mint.toBase58(),
  dbc_pool: pool.toBase58(),
  config_key: config.toBase58(),
  original_deployer: collector.toBase58(),
  mode: 'dev',
  recipient: collector.toBase58(),
  policy_version: 'dev-v1',
  quote_mint: NATIVE_MINT.toBase58(),
  activation_point: '42',
  creation_signature: 'creation',
  finalized_slot: '42',
};

function fixture() {
  const data = Buffer.alloc(82);
  data[44] = 6;
  data[45] = 1;
  const mintInfo = { data, owner: TOKEN_PROGRAM_ID, executable: false, lamports: 1 };
  const poolInfo = { ...mintInfo, owner: DYNAMIC_BONDING_CURVE_PROGRAM_ID };
  const batch = vi
    .fn()
    .mockResolvedValueOnce([mintInfo, poolInfo])
    .mockResolvedValueOnce([null, null]);
  const latest = vi.fn().mockResolvedValue({
    context: { slot: 44 },
    value: { blockhash: collector.toBase58(), lastValidBlockHeight: 100 },
  });
  const rpc = {
    getMultipleAccountsInfo: batch,
    getLatestBlockhashAndContext: latest,
    getFeeForMessage: vi.fn().mockResolvedValue({ value: 5000 }),
  } as unknown as Connection;
  return {
    batch,
    latest,
    mintInfo,
    poolInfo,
    adapter: new MeteoraWalletAdapter(rpc, coin.network_genesis, collector),
  };
}

beforeEach(() => {
  mocks.gate.mockResolvedValue({ collector });
  mocks.registered.mockResolvedValue(coin);
  mocks.config.mockResolvedValue({ quoteMint: NATIVE_MINT });
  mocks.pool.mockResolvedValue({ poolState: { baseMint: mint, config, activationPoint: 42 } });
});

it('reads mint and DBC ownership and both collector accounts in two finalized batches', async () => {
  const f = fixture();
  await expect(f.adapter.prepareSetup({ coin })).resolves.toMatchObject({ kind: 'setup' });
  expect(f.batch.mock.calls).toEqual([
    [[mint, pool], 'finalized'],
    [
      [
        getAssociatedTokenAddressSync(mint, collector),
        getAssociatedTokenAddressSync(NATIVE_MINT, collector),
      ],
      'finalized',
    ],
  ]);
});

it('fails before preparing a transaction when a finalized custody batch is incomplete', async () => {
  const f = fixture();
  f.batch.mockReset().mockResolvedValueOnce([f.mintInfo, f.poolInfo]).mockResolvedValueOnce([null]);
  await expect(f.adapter.prepareSetup({ coin })).rejects.toThrow(
    'Incomplete finalized collector account snapshot'
  );
  expect(f.latest).not.toHaveBeenCalled();
});
