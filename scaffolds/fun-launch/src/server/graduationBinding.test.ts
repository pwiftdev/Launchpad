import { createHash } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { BorshCoder, type Idl } from '@coral-xyz/anchor';
import {
  Connection,
  Keypair,
  PublicKey,
  Transaction,
  TransactionInstruction,
  ComputeBudgetProgram,
} from '@solana/web3.js';
import {
  DynamicBondingCurveIdl,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  StateService,
  derivePositionAddress,
  derivePositionNftAccount,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CpAmm, CP_AMM_PROGRAM_ID, CpAmmIdl } from '@meteora-ag/cp-amm-sdk';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';
import bs58 from 'bs58';
import { vaultAddresses } from '@/lib/vault/client';
import { FinalizedVerifier } from './economics/chainEvidence';
const f = vi.hoisted(() => ({
  registered: vi.fn(),
  config: vi.fn(),
  boundary: vi.fn(),
  discover: vi.fn(),
  load: vi.fn(),
}));
vi.mock('./launchRegistry', () => ({ registeredCoin: f.registered, registeredConfig: f.config }));
vi.mock('./migrationRegistry', () => ({
  migrationHistoryBoundary: f.boundary,
  discoverMigrationBoundary: f.discover,
}));
vi.mock('./damm', () => ({ loadMigratedPool: f.load, assertReleasedMigrationPolicy: () => {} }));
import { prepareVaultMigrationBinding, verifyFinalizedMigrationBinding } from './graduationBinding';
const rpc = new Connection('http://127.0.0.1:8899'),
  program = Keypair.generate().publicKey,
  mint = Keypair.generate().publicKey,
  operator = Keypair.generate(),
  creator = Keypair.generate().publicKey,
  config = Keypair.generate().publicKey,
  dbcPool = Keypair.generate().publicKey,
  pool = Keypair.generate().publicKey,
  nftMint = Keypair.generate().publicKey;
const addresses = vaultAddresses(program, mint),
  position = derivePositionAddress(nftMint),
  nftAccount = derivePositionNftAccount(nftMint),
  configData = Buffer.from('reviewed config bytes'),
  hash = createHash('sha256').update(configData).digest('hex');
const account = (data: Buffer, owner = program) => ({
  data,
  owner,
  executable: false,
  lamports: 1,
  rentEpoch: 0,
});
let native: Buffer, settings: Buffer;
beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  native = Buffer.alloc(347);
  native.write('RCOIN001');
  native[8] = 1;
  mint.toBuffer().copy(native, 11);
  dbcPool.toBuffer().copy(native, 43);
  config.toBuffer().copy(native, 75);
  creator.toBuffer().copy(native, 107);
  native.writeBigInt64LE(900n, 139);
  Buffer.from(hash, 'hex').copy(native, 291);
  settings = Buffer.alloc(107);
  settings.write('RSET0001');
  settings[8] = 1;
  operator.publicKey.toBuffer().copy(settings, 43);
  f.registered.mockResolvedValue({
    policy_version: 'rinse-v1',
    dbc_pool: dbcPool.toBase58(),
    config_key: config.toBase58(),
    original_deployer: creator.toBase58(),
    mode: 'creator',
    activation_point: '900',
  });
  f.config.mockResolvedValue({ policy_version: 'rinse-v1', config_digest: hash });
  f.boundary.mockResolvedValue({ signature: 'migration-proof', slot: '100' });
  f.load.mockResolvedValue({ address: pool, state: { liquidity: 1000 }, client: new CpAmm(rpc) });
  vi.spyOn(rpc, 'getGenesisHash').mockResolvedValue('genesis');
  vi.spyOn(rpc, 'getLatestBlockhash').mockResolvedValue({
    blockhash: PublicKey.default.toBase58(),
    lastValidBlockHeight: 300,
  });
  vi.spyOn(rpc, 'getMultipleAccountsInfoAndContext').mockImplementation(async () => ({
    context: { slot: 200 },
    value: [
      { ...account(Buffer.alloc(0)), executable: true },
      account(settings),
      account(native),
      account(Buffer.alloc(0), DYNAMIC_BONDING_CURVE_PROGRAM_ID),
      account(configData, DYNAMIC_BONDING_CURVE_PROGRAM_ID),
    ],
  }));
  vi.spyOn(StateService.prototype, 'getPoolConfig').mockResolvedValue({
    feeClaimer: addresses.feeAuthority,
  } as never);
  vi.spyOn(StateService.prototype, 'getPool').mockResolvedValue({
    poolState: { isMigrated: 1, baseMint: mint, config },
  } as never);
  const p = Buffer.alloc(408);
  Buffer.from(CpAmmIdl.accounts.find((a) => a.name === 'Position')!.discriminator).copy(p);
  pool.toBuffer().copy(p, 8);
  nftMint.toBuffer().copy(p, 40);
  p.writeBigUInt64LE(100n, 184);
  const n = Buffer.alloc(165);
  nftMint.toBuffer().copy(n);
  addresses.feeAuthority.toBuffer().copy(n, 32);
  n.writeBigUInt64LE(1n, 64);
  n[108] = 1;
  vi.spyOn(rpc, 'getMultipleAccountsInfo').mockImplementation(async (keys) =>
    keys.map((key) =>
      key.equals(position)
        ? account(p, CP_AMM_PROGRAM_ID)
        : key.equals(nftAccount)
          ? account(n, TOKEN_2022_PROGRAM_ID)
          : null
    )
  );
  const def = DynamicBondingCurveIdl.instructions.find((ix) => ix.name === 'migration_damm_v2')!,
    named: Record<string, PublicKey> = {
      base_mint: mint,
      virtual_pool: dbcPool,
      config,
      pool,
      first_position: position,
      first_position_nft_mint: nftMint,
      first_position_nft_account: nftAccount,
    };
  const message = new Transaction({
    feePayer: operator.publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
  })
    .add(
      new TransactionInstruction({
        programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
        keys: def.accounts.map((a) => ({
          pubkey:
            named[a.name] ??
            ('address' in a && a.address ? new PublicKey(a.address) : Keypair.generate().publicKey),
          isSigner: Boolean('signer' in a && a.signer),
          isWritable: Boolean('writable' in a && a.writable),
        })),
        data: new BorshCoder(DynamicBondingCurveIdl as unknown as Idl).instruction.encode(
          def.name,
          {}
        ),
      })
    )
    .compileMessage();
  vi.spyOn(rpc, 'getTransaction').mockResolvedValue({
    slot: 100,
    blockTime: 1000,
    meta: { err: null, loadedAddresses: { writable: [], readonly: [] } },
    transaction: { signatures: ['migration-proof'], message },
  } as never);
});
afterEach(() => vi.restoreAllMocks());
const prepare = () =>
  prepareVaultMigrationBinding({
    rpc,
    networkGenesis: 'genesis',
    programId: program,
    mint,
    operator: operator.publicKey,
  });
describe('operator migration binding', () => {
  it('prepares the actual migration position with Token-2022 NFT and outside LP present', async () => {
    const result = await prepare();
    expect(result.status).toBe('prepared');
    expect(result.expected).toEqual({
      pool: pool.toBase58(),
      position: position.toBase58(),
      nftAccount: nftAccount.toBase58(),
    });
    if (result.status !== 'prepared') throw new Error('Missing preparation');
    const tx = Transaction.from(Buffer.from(result.transactionBase64, 'base64'));
    expect(tx.feePayer?.equals(operator.publicKey)).toBe(true);
    expect(tx.instructions).toHaveLength(1);
    expect(
      tx.instructions[0]?.keys.filter((key) => key.isSigner).map((key) => key.pubkey.toBase58())
    ).toEqual([operator.publicKey.toBase58()]);
  });
  it('rejects an unauthorized operator and proves the actual bind instruction rather than any later transaction', async () => {
    await expect(
      prepareVaultMigrationBinding({
        rpc,
        networkGenesis: 'genesis',
        programId: program,
        mint,
        operator: Keypair.generate().publicKey,
      })
    ).rejects.toThrow('operator');
    const result = await prepare();
    if (result.status !== 'prepared') throw new Error('Missing preparation');
    pool.toBuffer().copy(native, 195);
    position.toBuffer().copy(native, 227);
    nftAccount.toBuffer().copy(native, 259);
    vi.spyOn(rpc, 'getAccountInfoAndContext').mockImplementation(async (address) => ({
      context: { slot: 200 },
      value: account(address.equals(addresses.coin) ? native : settings),
    }));
    const unrelated = new Transaction({
      feePayer: operator.publicKey,
      recentBlockhash: PublicKey.default.toBase58(),
    }).add(ComputeBudgetProgram.setComputeUnitLimit({ units: 100000 }));
    unrelated.partialSign(operator);
    const signature = bs58.encode(unrelated.signature!);
    vi.spyOn(rpc, 'getSignatureStatuses').mockResolvedValue({
      context: { slot: 200 },
      value: [{ slot: 100, confirmations: null, err: null, confirmationStatus: 'finalized' }],
    });
    vi.mocked(rpc.getTransaction).mockResolvedValue({
      slot: 100,
      blockTime: 1000,
      meta: { err: null, loadedAddresses: { writable: [], readonly: [] } },
      transaction: { signatures: [signature], message: unrelated.compileMessage() },
    } as never);
    const evidence = await new FinalizedVerifier(rpc, 'genesis').transaction(signature);
    await expect(
      verifyFinalizedMigrationBinding(evidence, program, mint, result.expected)
    ).rejects.toThrow('matching execution');
    const bound = Transaction.from(Buffer.from(result.transactionBase64, 'base64'));
    bound.partialSign(operator);
    const bindSignature = bs58.encode(bound.signature!);
    vi.mocked(rpc.getTransaction).mockResolvedValue({
      slot: 100,
      blockTime: 1000,
      meta: { err: null, loadedAddresses: { writable: [], readonly: [] } },
      transaction: { signatures: [bindSignature], message: bound.compileMessage() },
    } as never);
    const actual = await new FinalizedVerifier(rpc, 'genesis').transaction(bindSignature);
    await expect(
      verifyFinalizedMigrationBinding(actual, program, mint, result.expected)
    ).resolves.toMatchObject({ ...result.expected, signature: bindSignature, slot: 100 });
  });
});
