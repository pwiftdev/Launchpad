import { describe, expect, it, vi } from 'vitest';
import { Connection, Keypair, Transaction } from '@solana/web3.js';
import { MintLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  DynamicBondingCurveClient,
  deriveDbcPoolAddress,
  deriveDbcTokenVaultAddress,
  DAMM_V2_MIGRATION_FEE_ADDRESS,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import BN from 'bn.js';
import { assertLegacyPacketFits } from './transactionSize';

const mint = Keypair.generate().publicKey,
  creator = Keypair.generate().publicKey,
  config = Keypair.generate().publicKey;
const pool = deriveDbcPoolAddress(NATIVE_MINT, mint, config);
function setup() {
  const connection = new Connection('http://127.0.0.1:8899');
  const client = new DynamicBondingCurveClient(connection, 'confirmed');
  const configState = {
    tokenType: 0,
    quoteTokenFlag: 0,
    quoteMint: NATIVE_MINT,
    activationType: 1,
    poolFees: { baseFee: { baseFeeMode: 1 } },
  };
  vi.spyOn(client.state, 'getPoolConfig').mockResolvedValue(configState as never);
  vi.spyOn(
    (client.creator as unknown as { state: typeof client.state }).state,
    'getPoolConfig'
  ).mockResolvedValue(configState as never);
  vi.spyOn(connection, 'getAccountInfo').mockImplementation(async (key) =>
    key.equals(NATIVE_MINT)
      ? {
          data: Buffer.alloc(MintLayout.span),
          owner: TOKEN_PROGRAM_ID,
          lamports: 1,
          executable: false,
          rentEpoch: 0,
        }
      : null
  );
  return { client, configState };
}
function wireSize(tx: Transaction) {
  tx.feePayer = creator;
  tx.recentBlockhash = Keypair.generate().publicKey.toBase58();
  const message = tx.serializeMessage();
  // Legacy wire format: compact signature count +64 bytes per signature +message.
  return 1 + tx.compileMessage().header.numRequiredSignatures * 64 + message.length;
}
describe('real SDK wallet-operated launch and permissionless migration transaction sizes', () => {
  it('measures Meteora-only creation with and without the atomic 2% first buy', async () => {
    const { client } = setup();
    const createPoolParam = {
      config,
      baseMint: mint,
      name: 'N'.repeat(32),
      symbol: 'S'.repeat(10),
      uri: `https://gateway.pinata.cloud/ipfs/${'a'.repeat(59)}`,
      payer: creator,
      poolCreator: creator,
    };
    const plain = await client.creator.createPool(createPoolParam);
    const firstBuy = await client.creator.createPoolWithFirstBuy({
      createPoolParam,
      firstBuyParam: {
        buyer: creator,
        buyAmount: new BN(1_000_000_000),
        minimumAmountOut: new BN(20_000_000).mul(new BN(1_000_000)),
        referralTokenAccount: null,
      },
    });
    for (const tx of [plain, firstBuy]) {
      wireSize(tx);
      expect(tx.compileMessage().header.numRequiredSignatures).toBe(2);
    }
    const sizes = { create: wireSize(plain), firstBuy: wireSize(firstBuy) };
    console.log('Atomic launch legacy wire bytes:', sizes);
    expect(sizes.create).toBeLessThanOrEqual(1232);
    expect(sizes.firstBuy).toBeLessThanOrEqual(1232);
    expect(assertLegacyPacketFits(firstBuy)).toBe(sizes.firstBuy);
    const oversized = await client.creator.createPoolWithFirstBuy({
      createPoolParam: { ...createPoolParam, uri: 'u'.repeat(400) },
      firstBuyParam: {
        buyer: creator,
        buyAmount: new BN(1_000_000_000),
        minimumAmountOut: new BN(20_000_000).mul(new BN(1_000_000)),
        referralTokenAccount: null,
      },
    });
    oversized.feePayer = creator;
    oversized.recentBlockhash = Keypair.generate().publicKey.toBase58();
    expect(() => assertLegacyPacketFits(oversized)).toThrow('too large');
  });
  it('measures actual SDK DBC-to-DAMM migration with its two mint signers', async () => {
    const { client, configState } = setup();
    vi.spyOn(
      client.migration as unknown as { getPoolWithConfig: () => Promise<unknown> },
      'getPoolWithConfig'
    ).mockResolvedValue({
      virtualPool: {
        poolState: {
          baseMint: mint,
          config,
          baseVault: deriveDbcTokenVaultAddress(pool, mint),
          quoteVault: deriveDbcTokenVaultAddress(pool, NATIVE_MINT),
        },
      },
      poolConfigState: configState,
    } as never);
    const built = await client.migration.migrateToDammV2({
      pool,
      payer: creator,
      dammConfig: DAMM_V2_MIGRATION_FEE_ADDRESS[6]!,
    });
    const size = wireSize(built.transaction);
    console.log('Migration legacy wire bytes:', size);
    expect(built.transaction.compileMessage().header.numRequiredSignatures).toBe(3);
    expect(size).toBeLessThanOrEqual(1232);
  });
});
