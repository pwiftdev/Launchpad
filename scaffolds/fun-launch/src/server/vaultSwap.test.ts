import { describe, it, expect, vi, beforeEach } from 'vitest';
import BN from 'bn.js';
import { Keypair, PublicKey } from '@solana/web3.js';
import { NATIVE_MINT } from '@solana/spl-token';
import {
  StateService,
  deriveDbcPoolAddress,
  deriveDbcTokenVaultAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { vaultAddresses } from '@/lib/vault/client';

const f = vi.hoisted(() => ({
  network: vi.fn(),
  coin: vi.fn(),
  registered: vi.fn(),
  program: vi.fn(),
  route: vi.fn(),
}));
vi.mock('./dbc', async () => {
  const { Connection } = await import('@solana/web3.js');
  const { DynamicBondingCurveClient } = await import('@meteora-ag/dynamic-bonding-curve-sdk');
  const connection = new Connection('http://127.0.0.1:8899');
  return {
    connection,
    dbc: new DynamicBondingCurveClient(connection, 'finalized'),
    networkGenesis: f.network,
    getCoin: f.coin,
  };
});
vi.mock('./launchRegistry', () => ({ registeredCoin: f.registered }));
vi.mock('./launchConfig', () => ({ configuredVaultProgram: f.program }));
vi.mock('./migrationRegistry', () => ({ verifiedFinancialPool: f.route }));
import { connection, dbc } from './dbc';
import { prepareVaultSwap } from './vaultSwap';

const mint = Keypair.generate().publicKey,
  program = Keypair.generate().publicKey,
  configKey = Keypair.generate().publicKey;
const pool = deriveDbcPoolAddress(NATIVE_MINT, mint, configKey),
  addresses = vaultAddresses(program, mint);
const state = {
  config: configKey,
  baseMint: mint,
  isMigrated: 0,
  baseVault: deriveDbcTokenVaultAddress(pool, mint),
  quoteVault: deriveDbcTokenVaultAddress(pool, NATIVE_MINT),
};
describe('custody exact-input swap preparation', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    f.network.mockResolvedValue('local-genesis');
    f.program.mockReturnValue(program);
    f.registered.mockResolvedValue({
      policy_version: 'rinse-v1',
      dbc_pool: pool.toBase58(),
      config_key: configKey.toBase58(),
    });
    f.coin.mockResolvedValue({
      coin: { pool: pool.toBase58(), configKey: configKey.toBase58() },
      config: { tokenType: 0, quoteTokenFlag: 0, quoteMint: NATIVE_MINT },
      account: { poolState: state },
    });
    vi.spyOn(StateService.prototype, 'getPool').mockResolvedValue({ poolState: state } as never);
    vi.spyOn(connection, 'getSlot').mockResolvedValue(100);
    vi.spyOn(connection, 'getBlockTime').mockResolvedValue(1_000);
    vi.spyOn(dbc.pool, 'swapQuote').mockReturnValue({
      outputAmount: new BN(500),
      minimumAmountOut: new BN(490),
    } as never);
  });
  it('builds only raw DBC swap with PDA-owned source/destination and exact integer amounts', async () => {
    const result = await prepareVaultSwap({
      mint,
      coinPDA: addresses.coin,
      amount: new BN(100),
      slippageBps: 200,
    });
    expect(result.route).toBe(0);
    expect(result.instruction.keys[3]?.pubkey.equals(addresses.quoteAccount)).toBe(true);
    expect(result.instruction.keys[4]?.pubkey.equals(addresses.tokenAccount)).toBe(true);
    expect(
      result.instruction.keys.filter((k) => k.isSigner).map((k) => k.pubkey.toBase58())
    ).toEqual([addresses.coin.toBase58()]);
    expect(result.instruction.data.readBigUInt64LE(8)).toBe(100n);
    expect(result.instruction.data.readBigUInt64LE(16)).toBe(490n);
    expect(result.quote.outputAmount.eqn(500)).toBe(true);
    expect(result.stateSlot).toBe(100);
  });
  it('fails closed for mismatched coin authority, unreviewed policy and unbounded amount', async () => {
    await expect(
      prepareVaultSwap({ mint, coinPDA: PublicKey.default, amount: new BN(100), slippageBps: 200 })
    ).rejects.toThrow('custody PDA');
    f.registered.mockResolvedValue(null);
    await expect(
      prepareVaultSwap({ mint, coinPDA: addresses.coin, amount: new BN(100), slippageBps: 200 })
    ).rejects.toThrow('immutable');
    await expect(
      prepareVaultSwap({
        mint,
        coinPDA: addresses.coin,
        amount: new BN(1).shln(64),
        slippageBps: 200,
      })
    ).rejects.toThrow('Invalid');
  });
  it('permits a strict zero-slippage quote', async () => {
    await expect(
      prepareVaultSwap({ mint, coinPDA: addresses.coin, amount: new BN(100), slippageBps: 0 })
    ).resolves.toHaveProperty('route', 0);
  });
});
