import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  type Connection,
  PublicKey,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import { AccountLayout, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import BN from 'bn.js';
import { vaultAddresses } from '@/lib/vault/client';
import { registeredCoin, type RegisteredCoin } from '../launchRegistry';
import { prepareVaultSwap } from '../vaultSwap';
import { MeteoraFinancialAdapter } from './meteoraAdapter';
import type { FinancialStore } from './financialStore';
import { fixtureGenesis, fixtureWallet } from './financialFixtures';

vi.mock('../vaultSwap', () => ({ prepareVaultSwap: vi.fn() }));
vi.mock('../launchRegistry', async (original) => ({
  ...(await original<typeof import('../launchRegistry')>()),
  registeredCoin: vi.fn(),
}));
beforeEach(() => vi.clearAllMocks());

function setup() {
  const program = fixtureWallet().publicKey,
    operator = fixtureWallet().publicKey,
    mint = fixtureWallet().publicKey,
    creator = fixtureWallet().publicKey,
    pool = fixtureWallet().publicKey,
    config = fixtureWallet().publicKey;
  const addresses = vaultAddresses(program, mint),
    data = Buffer.alloc(347),
    settings = Buffer.alloc(107);
  settings.write('RSET0001');
  settings[8] = 1;
  operator.toBuffer().copy(settings, 43);
  data.write('RCOIN001');
  data[8] = 1;
  mint.toBuffer().copy(data, 11);
  pool.toBuffer().copy(data, 43);
  config.toBuffer().copy(data, 75);
  creator.toBuffer().copy(data, 107);
  data.writeBigInt64LE(1000n, 139);
  data.writeBigUInt64LE(100n, 147);
  data.writeBigUInt64LE(7n, 179);
  const info = (value: Buffer, owner = program) => ({
    owner,
    data: value,
    lamports: 2039280,
    executable: false,
    rentEpoch: 0,
  });
  const token = (tokenMint: PublicKey, native: boolean) => {
    const bytes = Buffer.alloc(AccountLayout.span);
    AccountLayout.encode(
      {
        mint: tokenMint,
        owner: addresses.coin,
        amount: 0n,
        delegateOption: 0,
        delegate: PublicKey.default,
        state: 1,
        isNativeOption: (native ? 1 : 0) as 0 | 1,
        isNative: native ? 2039280n : 0n,
        delegatedAmount: 0n,
        closeAuthorityOption: 0,
        closeAuthority: PublicKey.default,
      },
      bytes
    );
    return info(bytes, TOKEN_PROGRAM_ID);
  };
  const rpc = {
    getGenesisHash: async () => fixtureGenesis,
    getMultipleAccountsInfoAndContext: async () => ({
      context: { slot: 1000 },
      value: [info(settings), info(data)],
    }),
    getMultipleAccountsInfo: async () => [token(NATIVE_MINT, true), token(mint, false)],
    getBlockTime: async () => 3600,
    getLatestBlockhash: async () => ({
      blockhash: fixtureWallet().publicKey.toBase58(),
      lastValidBlockHeight: 2000,
    }),
  } as unknown as Connection;
  vi.mocked(registeredCoin).mockResolvedValue({
    network_genesis: fixtureGenesis,
    mint: mint.toBase58(),
    dbc_pool: pool.toBase58(),
    config_key: config.toBase58(),
    original_deployer: creator.toBase58(),
    mode: 'creator',
    recipient: creator.toBase58(),
    policy_version: 'rinse-v1',
    activation_point: '1000',
    creation_signature: 'test',
    finalized_slot: '1',
  } as RegisteredCoin);
  const baseVault = fixtureWallet().publicKey,
    quoteVault = fixtureWallet().publicKey,
    dex = fixtureWallet().publicKey;
  const instruction = new TransactionInstruction({
    programId: dex,
    keys: [
      { pubkey: addresses.coin, isSigner: true, isWritable: false },
      { pubkey: pool, isSigner: false, isWritable: true },
      { pubkey: baseVault, isSigner: false, isWritable: true },
    ],
    data: Buffer.from([1, 2, 3]),
  });
  vi.mocked(prepareVaultSwap).mockResolvedValue({
    route: 0 as const,
    pool,
    baseVault,
    quoteVault,
    programId: dex,
    instruction,
    stateSlot: 1000,
    quote: { outputAmount: new BN(100), minimumAmountOut: new BN(99) },
  });
  const store = {
    balances: async () => [
      { bucket: 'rinse_buyback', funded: '100', spent: '0', reserved: '0', available: '100' },
    ],
  } as unknown as FinancialStore;
  return {
    program,
    operator,
    mint,
    pool,
    addresses,
    data,
    settings,
    instruction,
    adapter: new MeteoraFinancialAdapter(rpc, store, program, operator, fixtureGenesis),
  };
}

describe('concrete unsigned Meteora vault adapter', () => {
  it('wraps exact SDK CPI bytes, amount, nonce, output limit and deadline without adding a PDA as an external signer', async () => {
    const test = setup();
    const quote = await test.adapter.quote({
      networkGenesis: fixtureGenesis,
      mint: test.mint.toBase58(),
      amount: 50n,
      clock: { networkGenesis: fixtureGenesis, slot: 1000, blockTime: 3600 },
      maximumSlippageBps: 100,
    });
    const tx = VersionedTransaction.deserialize(Buffer.from(quote.transactionBase64, 'base64'));
    expect(tx.message.header.numRequiredSignatures).toBe(1);
    expect(tx.message.staticAccountKeys[0]!.equals(test.operator)).toBe(true);
    expect(tx.signatures.every((signature) => signature.every((byte) => byte === 0))).toBe(true);
    const data = Buffer.from(quote.expectation.dataBase64, 'base64');
    expect(data.readBigUInt64LE(8)).toBe(7n);
    expect(data.readBigUInt64LE(16)).toBe(50n);
    expect(data.readBigUInt64LE(24)).toBe(99n);
    expect(data.readBigInt64LE(32)).toBe(3630n);
    expect(data.subarray(43)).toEqual(test.instruction.data);
    expect(quote.expectation.tokenAccount).toBe(test.addresses.tokenAccount.toBase58());
  });
  it('refuses paused or mismatched custody budgets and unexpected external SDK signers', async () => {
    const test = setup();
    test.settings[10] = 1;
    await expect(
      test.adapter.quote({
        networkGenesis: fixtureGenesis,
        mint: test.mint.toBase58(),
        amount: 50n,
        clock: { networkGenesis: fixtureGenesis, slot: 1000, blockTime: 3600 },
        maximumSlippageBps: 100,
      })
    ).rejects.toThrow('unpaused');
    test.settings[10] = 0;
    test.data.writeBigUInt64LE(99n, 147);
    await expect(
      test.adapter.quote({
        networkGenesis: fixtureGenesis,
        mint: test.mint.toBase58(),
        amount: 50n,
        clock: { networkGenesis: fixtureGenesis, slot: 1000, blockTime: 3600 },
        maximumSlippageBps: 100,
      })
    ).rejects.toThrow('Reconcile');
    test.data.writeBigUInt64LE(100n, 147);
    test.instruction.keys.push({
      pubkey: fixtureWallet().publicKey,
      isSigner: true,
      isWritable: false,
    });
    await expect(
      test.adapter.quote({
        networkGenesis: fixtureGenesis,
        mint: test.mint.toBase58(),
        amount: 50n,
        clock: { networkGenesis: fixtureGenesis, slot: 1000, blockTime: 3600 },
        maximumSlippageBps: 100,
      })
    ).rejects.toThrow('external');
  });
});
