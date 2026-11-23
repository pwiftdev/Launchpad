import { describe, expect, it, vi } from 'vitest';
import { Connection, Keypair, PublicKey } from '@solana/web3.js';
import { NATIVE_MINT, TOKEN_PROGRAM_ID, MintLayout } from '@solana/spl-token';
import {
  CpAmmIdl,
  CP_AMM_PROGRAM_ID,
  MIN_SQRT_PRICE,
  MAX_SQRT_PRICE,
} from '@meteora-ag/cp-amm-sdk';
import {
  DAMM_V2_MIGRATION_FEE_ADDRESS,
  deriveDammV2PoolAddress,
  type PoolConfig,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import BN from 'bn.js';
import {
  assertMigratedPair,
  loadMigratedPool,
  migratedPoolAddress,
  migratedPrice,
  migratedSwap,
  assertReleasedMigrationPolicy,
} from './damm';

const mint = Keypair.generate().publicKey;
const config = { quoteMint: NATIVE_MINT, migrationOption: 1, migrationFeeOption: 6 } as PoolConfig;
function account(data: Buffer, owner = TOKEN_PROGRAM_ID) {
  return { data, owner, lamports: 1, executable: false, rentEpoch: 0 };
}
function poolData(collect = 1) {
  const data = Buffer.alloc(1112),
    discriminator = CpAmmIdl.accounts.find((a) => a.name === 'Pool')?.discriminator;
  if (!discriminator) throw new Error('Missing fixture discriminator');
  Buffer.from(discriminator).copy(data, 0);
  data.writeBigUInt64LE(12_500_000n, 8); // Static 1.25% base fee, SDK PodAlignedFeeTimeScheduler.
  data[48] = 20;
  mint.toBuffer().copy(data, 168);
  NATIVE_MINT.toBuffer().copy(data, 200);
  Keypair.generate().publicKey.toBuffer().copy(data, 232);
  Keypair.generate().publicKey.toBuffer().copy(data, 264);
  const u128 = (value: BN, at: number) => Buffer.from(value.toArray('le', 16)).copy(data, at);
  u128(new BN('100000000000000000000000000'), 360);
  u128(MIN_SQRT_PRICE, 424);
  u128(MAX_SQRT_PRICE, 440);
  u128(new BN(1).shln(64), 456);
  data[480] = 1;
  data[484] = collect;
  return data;
}
function mintData(decimals: number) {
  const data = Buffer.alloc(MintLayout.span);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply: 1_000_000_000_000n,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data
  );
  return account(data);
}
function rpc(collect = 1) {
  const connection = new Connection('http://127.0.0.1:8899');
  vi.spyOn(connection, 'getAccountInfo').mockResolvedValue(
    account(poolData(collect), CP_AMM_PROGRAM_ID)
  );
  vi.spyOn(connection, 'getMultipleAccountsInfo').mockResolvedValue([mintData(6), mintData(9)]);
  vi.spyOn(connection, 'getEpochInfo').mockResolvedValue({
    epoch: 1,
    slotIndex: 1,
    slotsInEpoch: 100,
    absoluteSlot: 101,
  });
  vi.spyOn(connection, 'getSlot').mockResolvedValue(101);
  vi.spyOn(connection, 'getBlockTime').mockResolvedValue(1_000);
  return connection;
}
describe('verified graduation routing', () => {
  it('permits post-RINSE accounting only at the actual static floor with SOL collection', async () => {
    const { state } = await loadMigratedPool(rpc(), config, mint);
    expect(() => assertReleasedMigrationPolicy(state, mint)).not.toThrow();
    expect(() => assertReleasedMigrationPolicy({ ...state, collectFeeMode: 0 }, mint)).toThrow(
      'fee policy'
    );
    const dynamic = {
      ...state,
      poolFees: { ...state.poolFees, dynamicFee: { ...state.poolFees.dynamicFee, initialized: 1 } },
    };
    expect(() => assertReleasedMigrationPolicy(dynamic, mint)).toThrow('fee policy');
    expect(() => assertReleasedMigrationPolicy({ ...state, activationType: 0 }, mint)).toThrow(
      'fee policy'
    );
  });
  it('uses the canonical migration config rather than selecting an arbitrary pool with the same mint', () => {
    const canonical = DAMM_V2_MIGRATION_FEE_ADDRESS[6];
    if (!canonical) throw new Error('Missing canonical config');
    expect(migratedPoolAddress(config, mint)).toEqual(
      deriveDammV2PoolAddress(canonical, mint, NATIVE_MINT)
    );
    expect(() => migratedPoolAddress({ ...config, migrationOption: 0 }, mint)).toThrow();
    expect(() => migratedPoolAddress({ ...config, migrationFeeOption: 99 }, mint)).toThrow();
    expect(() =>
      assertMigratedPair({ tokenAMint: mint, tokenBMint: Keypair.generate().publicKey }, mint)
    ).toThrow();
  });
  it('rejects another program account at the expected address', async () => {
    const connection = rpc();
    vi.mocked(connection.getAccountInfo).mockResolvedValue(account(poolData(), TOKEN_PROGRAM_ID));
    await expect(loadMigratedPool(connection, config, mint)).rejects.toThrow('valid DAMM');
  });
  it('decodes real SDK layout and uses actual mint decimals for both price orientations', async () => {
    const pool = await loadMigratedPool(rpc(), config, mint);
    expect(pool.state.tokenAMint.equals(mint)).toBe(true);
    expect(migratedPrice(pool.state, mint, 6)).toBeCloseTo(0.001, 12);
    expect(
      migratedPrice({ ...pool.state, tokenAMint: NATIVE_MINT, tokenBMint: mint }, mint, 6)
    ).toBeCloseTo(0.001, 12);
  });
  it('quotes buys and sells through the real DAMM math, preserving the SOL-only fee unit', async () => {
    const connection = rpc();
    const buy = await migratedSwap(connection, config, mint, 'buy', new BN(1_000_000_000), 100);
    expect(buy.amountOut.gt(new BN(0))).toBe(true);
    expect(buy.minimumAmountOut.lt(buy.amountOut)).toBe(true);
    expect(buy.feeMint).toBe(NATIVE_MINT.toBase58());
    expect(buy.feeSol).toBeCloseTo(0.0125, 8);
    expect(buy.feeSolIsEstimate).toBe(false);
    const sell = await migratedSwap(connection, config, mint, 'sell', new BN(1_000_000), 100);
    expect(sell.amountOut.gt(new BN(0))).toBe(true);
    expect(sell.feeMint).toBe(NATIVE_MINT.toBase58());
  });
  it('labels legacy output-token fees as tokens instead of claiming they are SOL', async () => {
    const quote = await migratedSwap(rpc(0), config, mint, 'buy', new BN(1_000_000_000), 0);
    expect(quote.feeMint).toBe(mint.toBase58());
    expect(quote.feeSolIsEstimate).toBe(true);
    expect(quote.feeAmount).toBeGreaterThan(0);
    expect(quote.feeSol).toBeCloseTo(quote.feeAmount * 0.001, 12);
  });
});
