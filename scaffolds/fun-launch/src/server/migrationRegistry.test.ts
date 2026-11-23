import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { BorshCoder, type Idl } from '@coral-xyz/anchor';
import { Keypair, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
import {
  DynamicBondingCurveIdl,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  StateService,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import BN from 'bn.js';
const f = vi.hoisted(() => ({
  query: vi.fn(),
  registered: vi.fn(),
  genesis: vi.fn(),
  load: vi.fn(),
  address: vi.fn(),
  tx: vi.fn(),
  signatures: vi.fn(),
  snapshot: vi.fn(),
}));
vi.mock('./dbc', () => ({
  networkGenesis: f.genesis,
  connection: {
    getTransaction: f.tx,
    getSignaturesForAddress: f.signatures,
    getAccountInfoAndContext: f.snapshot,
  },
}));
vi.mock('./database', () => ({ database: () => ({ query: f.query }) }));
vi.mock('./launchRegistry', () => ({ registeredCoin: f.registered }));
vi.mock('./damm', () => ({
  loadMigratedPool: f.load,
  migratedPoolAddress: f.address,
  assertReleasedMigrationPolicy: () => {},
}));
import { discoverMigrationBoundary } from './migrationRegistry';
const mint = Keypair.generate().publicKey,
  dbcPool = Keypair.generate().publicKey,
  dammPool = Keypair.generate().publicKey,
  config = Keypair.generate().publicKey;
beforeEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
  let mapped = false,
    proof: unknown;
  f.query.mockImplementation(async (sql: string, args: unknown[]) => {
    if (sql.startsWith('INSERT INTO launch_migrations')) mapped = true;
    if (sql.startsWith('INSERT INTO launch_migration_proofs'))
      proof = { creation_signature: args[2], creation_slot: String(args[3]) };
    if (sql.includes('FROM launch_migration_proofs')) return { rows: proof ? [proof] : [] };
    if (sql.includes('FROM launch_migrations'))
      return {
        rows: mapped
          ? [{ damm_pool: dammPool.toBase58(), migration_activation_point: '1000' }]
          : [],
      };
    return { rows: [] };
  });
  f.genesis.mockResolvedValue('genesis');
  f.registered.mockResolvedValue({
    dbc_pool: dbcPool.toBase58(),
    config_key: config.toBase58(),
    activation_point: '900',
    policy_version: 'rinse-v1',
  });
  f.address.mockReturnValue(dammPool);
  f.load.mockResolvedValue({
    address: dammPool,
    state: { activationPoint: new BN(1000), activationType: 1 },
  });
  f.snapshot.mockResolvedValue({
    context: { slot: 123 },
    value: { data: Buffer.from('actual pool snapshot') },
  });
  vi.spyOn(StateService.prototype, 'getPoolConfig').mockResolvedValue({} as never);
  vi.spyOn(StateService.prototype, 'getPoolByBaseMint').mockResolvedValue({
    publicKey: dbcPool,
    account: { poolState: { config, isMigrated: 1 } },
  } as never);
  const definition = DynamicBondingCurveIdl.instructions.find(
    (ix) => ix.name === 'migration_damm_v2'
  )!;
  const named: Record<string, PublicKey> = {
    base_mint: mint,
    virtual_pool: dbcPool,
    pool: dammPool,
    config,
  };
  const message = new Transaction({
    feePayer: Keypair.generate().publicKey,
    recentBlockhash: PublicKey.default.toBase58(),
  })
    .add(
      new TransactionInstruction({
        programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
        keys: definition.accounts.map((account) => ({
          pubkey:
            named[account.name] ??
            ('address' in account && account.address
              ? new PublicKey(account.address)
              : Keypair.generate().publicKey),
          isSigner: Boolean('signer' in account && account.signer),
          isWritable: Boolean('writable' in account && account.writable),
        })),
        data: new BorshCoder(DynamicBondingCurveIdl as unknown as Idl).instruction.encode(
          definition.name,
          {}
        ),
      })
    )
    .compileMessage();
  f.tx.mockResolvedValue({
    slot: 100,
    blockTime: 1000,
    meta: { err: null, loadedAddresses: { writable: [], readonly: [] } },
    transaction: { signatures: ['migration-signature'], message },
  });
  f.signatures.mockResolvedValue([
    { signature: 'migration-signature', slot: 100, blockTime: 1000, err: null },
  ]);
});
afterEach(() => vi.restoreAllMocks());
describe('first-pass migrated history discovery', () => {
  it('verifies and creates the canonical mapping before scanning the actual finalized boundary', async () => {
    await expect(discoverMigrationBoundary('genesis', mint.toBase58())).resolves.toEqual({
      signature: 'migration-signature',
      slot: '100',
    });
    expect(f.signatures).toHaveBeenCalledWith(
      dammPool,
      { before: undefined, limit: 1000 },
      'finalized'
    );
  });
  it('never discovers or registers a boundary for an unregistered coin', async () => {
    f.registered.mockResolvedValue(null);
    await expect(discoverMigrationBoundary('genesis', mint.toBase58())).resolves.toBeNull();
    expect(f.signatures).not.toHaveBeenCalled();
  });
});
