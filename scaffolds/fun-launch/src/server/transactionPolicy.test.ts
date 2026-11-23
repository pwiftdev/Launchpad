import { BorshCoder, type Idl } from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
} from '@solana/web3.js';
import { getAssociatedTokenAddressSync, NATIVE_MINT } from '@solana/spl-token';
import {
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  DynamicBondingCurveIdl,
  deriveDbcPoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CP_AMM_PROGRAM_ID, CpAmmIdl } from '@meteora-ag/cp-amm-sdk';
import BN from 'bn.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claimCommunityInstruction, claimCreatorInstruction } from '@/lib/vault/client';
import { validateRelayTransaction } from './transactionPolicy';

const mocks = vi.hoisted(() => ({
  getCoin: vi.fn(),
  getLaunchConfig: vi.fn(),
  supportedConfig: vi.fn(),
  networkGenesis: vi.fn(),
  launchIntent: vi.fn(),
  registeredCoin: vi.fn(),
  registeredConfig: vi.fn(),
  registeredConfigKeys: vi.fn(),
}));
vi.mock('./dbc', () => ({
  getCoin: mocks.getCoin,
  getLaunchConfig: mocks.getLaunchConfig,
  supportedConfig: mocks.supportedConfig,
  networkGenesis: mocks.networkGenesis,
  connection: {},
  dbc: {},
}));
vi.mock('./launchRegistry', () => ({
  launchIntent: mocks.launchIntent,
  registeredCoin: mocks.registeredCoin,
  registeredConfig: mocks.registeredConfig,
  registeredConfigKeys: mocks.registeredConfigKeys,
}));
const payer = Keypair.generate().publicKey,
  mint = Keypair.generate().publicKey,
  pool = Keypair.generate().publicKey,
  config = Keypair.generate().publicKey,
  program = Keypair.generate().publicKey;
function swap(migrated = false) {
  const idl = (migrated ? CpAmmIdl : DynamicBondingCurveIdl) as unknown as Idl;
  const definition = idl.instructions.find((ix) => ix.name === 'swap');
  if (!definition) throw new Error('Missing fixture instruction');
  const named: Record<string, PublicKey> = {
    payer,
    base_mint: mint,
    quote_mint: NATIVE_MINT,
    config,
    pool,
    token_a_mint: mint,
    token_b_mint: NATIVE_MINT,
    input_token_account: getAssociatedTokenAddressSync(NATIVE_MINT, payer),
    output_token_account: getAssociatedTokenAddressSync(mint, payer),
  };
  const keyFields = definition.accounts as {
    name: string;
    address?: string;
    writable?: boolean;
    signer?: boolean;
  }[];
  const coder = new BorshCoder(idl),
    amounts = { amount_in: new BN(1), minimum_amount_out: new BN(0) };
  return new TransactionInstruction({
    programId: migrated ? CP_AMM_PROGRAM_ID : DYNAMIC_BONDING_CURVE_PROGRAM_ID,
    keys: keyFields.map((a) => ({
      pubkey:
        named[a.name] ?? (a.address ? new PublicKey(a.address) : Keypair.generate().publicKey),
      isSigner: Boolean(a.signer),
      isWritable: Boolean(a.writable),
    })),
    data: coder.instruction.encode('swap', migrated ? { _params: amounts } : { params: amounts }),
  });
}
function tx(...instructions: TransactionInstruction[]) {
  return new Transaction({
    feePayer: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
  }).add(...instructions);
}
beforeEach(() => {
  vi.stubEnv('VAULT_PROGRAM_ID', program.toBase58());
  vi.stubEnv('NEXT_PUBLIC_VAULT_PROGRAM_ID', program.toBase58());
  mocks.networkGenesis.mockResolvedValue('devnet-test');
  mocks.supportedConfig.mockResolvedValue(true);
  mocks.getCoin.mockResolvedValue({
    coin: { pool: pool.toBase58(), isMigrated: false, migratedPool: pool.toBase58() },
    config: { collectFeeMode: 0 },
    account: { poolState: { config } },
  });
  mocks.registeredCoin.mockResolvedValue({
    policy_version: 'rinse-v1',
    mode: 'creator',
    original_deployer: payer.toBase58(),
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.clearAllMocks();
});
describe('transaction relay instruction policy', () => {
  it('accepts wallet-v1 creation with immutable signed intent and no custom program instruction', async () => {
    vi.stubEnv('DATABASE_URL', 'postgres://unused.example/test');
    vi.stubEnv('VAULT_PROGRAM_ID', '');
    vi.stubEnv('NEXT_PUBLIC_VAULT_PROGRAM_ID', '');
    const definition = DynamicBondingCurveIdl.instructions.find(
      (ix) => ix.name === 'initialize_virtual_pool_with_spl_token'
    )!;
    const canonicalPool = deriveDbcPoolAddress(NATIVE_MINT, mint, config),
      named: Record<string, PublicKey> = {
        creator: payer,
        payer,
        base_mint: mint,
        quote_mint: NATIVE_MINT,
        config,
        pool: canonicalPool,
      };
    const instruction = new TransactionInstruction({
      programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      keys: definition.accounts.map((a) => ({
        pubkey:
          named[a.name] ??
          ('address' in a && a.address ? new PublicKey(a.address) : Keypair.generate().publicKey),
        isSigner: Boolean('signer' in a && a.signer),
        isWritable: Boolean('writable' in a && a.writable),
      })),
      data: new BorshCoder(DynamicBondingCurveIdl as unknown as Idl).instruction.encode(
        definition.name,
        { params: { name: 'Wallet', symbol: 'WALL', uri: 'https://example.test/meta.json' } }
      ),
    });
    mocks.launchIntent.mockResolvedValue({
      deployer: payer.toBase58(),
      config_key: config.toBase58(),
      mode: 'community',
    });
    mocks.getLaunchConfig.mockResolvedValue({
      key: config,
      record: { policy_version: 'wallet-v1' },
      config: { tokenType: 0 },
    });
    await expect(validateRelayTransaction(tx(instruction))).resolves.toBeUndefined();
    const unexpected = new TransactionInstruction({
      programId: program,
      keys: [],
      data: Buffer.alloc(8),
    });
    await expect(validateRelayTransaction(tx(instruction, unexpected))).rejects.toThrow(
      'Unexpected program'
    );
    mocks.launchIntent.mockResolvedValue({
      deployer: mint.toBase58(),
      config_key: config.toBase58(),
      mode: 'community',
    });
    await expect(validateRelayTransaction(tx(instruction))).rejects.toThrow('Signed launch intent');
  });
  it('allows known DBC trades and the signer’s own SOL wrapping only', async () => {
    const wrap = SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: getAssociatedTokenAddressSync(NATIVE_MINT, payer),
      lamports: 1,
    });
    await expect(validateRelayTransaction(tx(wrap, swap()))).resolves.toBeUndefined();
  });
  it('rejects a transaction padded with a DBC instruction to relay an unrelated transfer', async () => {
    const theft = SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: Keypair.generate().publicKey,
      lamports: 1,
    });
    await expect(validateRelayTransaction(tx(swap(), theft))).rejects.toThrow('wrapping');
    await expect(validateRelayTransaction(tx(theft))).rejects.toThrow();
  });
  it('rejects unknown or mismatched DBC pools', async () => {
    mocks.getCoin.mockResolvedValue(null);
    await expect(validateRelayTransaction(tx(swap()))).rejects.toThrow('Unknown');
    mocks.supportedConfig.mockResolvedValue(false);
    await expect(validateRelayTransaction(tx(swap()))).rejects.toThrow('configuration');
  });
  it('rejects a known-pool swap redirecting output to a different wallet', async () => {
    for (const migrated of [false, true]) {
      mocks.getCoin.mockResolvedValue({
        coin: { pool: pool.toBase58(), isMigrated: migrated, migratedPool: pool.toBase58() },
        config: { tokenType: 0 },
        account: { poolState: { config } },
      });
      const instruction = swap(migrated),
        idl = migrated ? CpAmmIdl : DynamicBondingCurveIdl;
      const index = idl.instructions
        .find((ix) => ix.name === 'swap')!
        .accounts.findIndex((account) => account.name === 'output_token_account');
      instruction.keys[index]!.pubkey = getAssociatedTokenAddressSync(
        mint,
        Keypair.generate().publicKey
      );
      await expect(validateRelayTransaction(tx(instruction))).rejects.toThrow('signing wallet');
    }
  });
  it('allows only a verified deterministic graduated DAMM pool', async () => {
    mocks.getCoin.mockResolvedValue({ coin: { isMigrated: true, migratedPool: pool.toBase58() } });
    await expect(validateRelayTransaction(tx(swap(true)))).resolves.toBeUndefined();
    mocks.getCoin.mockResolvedValue({
      coin: { isMigrated: true, migratedPool: Keypair.generate().publicKey.toBase58() },
    });
    await expect(validateRelayTransaction(tx(swap(true)))).rejects.toThrow('Unknown migrated');
  });
  it('allows canonical creator claims only for the original deployer', async () => {
    const claim = claimCreatorInstruction(program, mint, payer, 100n);
    await expect(
      validateRelayTransaction(
        tx(ComputeBudgetProgram.setComputeUnitLimit({ units: 100_000 }), claim),
        { claimMint: mint }
      )
    ).resolves.toBeUndefined();
    mocks.registeredCoin.mockResolvedValue({
      policy_version: 'rinse-v1',
      mode: 'creator',
      original_deployer: Keypair.generate().publicKey.toBase58(),
    });
    await expect(validateRelayTransaction(tx(claim), { claimMint: mint })).rejects.toThrow(
      'authority'
    );
  });
  it('rejects claim recipient substitution and additional money-moving instructions', async () => {
    mocks.registeredCoin.mockResolvedValue({ policy_version: 'rinse-v1', mode: 'community' });
    const claim = claimCommunityInstruction({
      programId: program,
      mint,
      wallet: payer,
      epoch: 3600n,
      amount: 1n,
      proof: [],
    });
    await expect(validateRelayTransaction(tx(claim), { claimMint: mint })).resolves.toBeUndefined();
    const bad = claimCommunityInstruction({
      programId: program,
      mint,
      wallet: Keypair.generate().publicKey,
      epoch: 3600n,
      amount: 1n,
      proof: [],
    });
    await expect(validateRelayTransaction(tx(bad), { claimMint: mint })).rejects.toThrow(
      'authority'
    );
    const wrap = SystemProgram.transfer({
      fromPubkey: payer,
      toPubkey: getAssociatedTokenAddressSync(NATIVE_MINT, payer),
      lamports: 1,
    });
    await expect(validateRelayTransaction(tx(claim, wrap), { claimMint: mint })).rejects.toThrow(
      'additional'
    );
  });
});
