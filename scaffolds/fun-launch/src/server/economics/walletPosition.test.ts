import { expect, it, vi } from 'vitest';
import { TransactionInstruction, PublicKey, type Connection } from '@solana/web3.js';
import { AccountLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import { CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk';
import {
  DynamicBondingCurveIdl,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  derivePositionAddress,
  derivePositionNftAccount,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import BN from 'bn.js';
import { fixtureWallet, fixtureGenesis, transactionFixture } from './financialFixtures';
import { walletMigrationPosition } from './walletPosition';
import type { RegisteredCoin } from '../launchRegistry';
import type { loadMigratedPool } from '../damm';
const boundary = vi.hoisted(() => vi.fn());
vi.mock('../migrationRegistry', () => ({
  migrationHistoryBoundary: boundary,
  discoverMigrationBoundary: vi.fn(),
}));

it('ignores unsolicited System-account dust on an unused migration candidate', async () => {
  const collector = fixtureWallet().publicKey,
    nftMint = fixtureWallet().publicKey,
    pool = fixtureWallet().publicKey,
    mint = fixtureWallet().publicKey,
    config = fixtureWallet().publicKey,
    dbcPool = fixtureWallet().publicKey;
  const firstPosition = derivePositionAddress(nftMint),
    firstNft = derivePositionNftAccount(nftMint),
    secondMint = fixtureWallet().publicKey,
    secondPosition = derivePositionAddress(secondMint),
    secondNft = derivePositionNftAccount(secondMint);
  const bound: Record<string, PublicKey> = {
    virtual_pool: dbcPool,
    config,
    pool,
    base_mint: mint,
    first_position_nft_mint: nftMint,
    first_position: firstPosition,
    first_position_nft_account: firstNft,
    second_position_nft_mint: secondMint,
    second_position: secondPosition,
    second_position_nft_account: secondNft,
  };
  const definition = DynamicBondingCurveIdl.instructions.find(
    (i) => i.name === 'migration_damm_v2'
  )!;
  const t = transactionFixture([
    new TransactionInstruction({
      programId: DYNAMIC_BONDING_CURVE_PROGRAM_ID,
      keys: definition.accounts.map((a) => ({
        pubkey: bound[a.name] ?? fixtureWallet().publicKey,
        isSigner: false,
        isWritable: false,
      })),
      data: Buffer.from(definition.discriminator),
    }),
  ]);
  boundary.mockResolvedValue({ signature: t.signature, slot: t.response.slot.toString() });
  const data = Buffer.alloc(AccountLayout.span);
  AccountLayout.encode(
    {
      mint: nftMint,
      owner: collector,
      amount: 1n,
      delegateOption: 0,
      delegate: PublicKey.default,
      state: 1,
      isNativeOption: 0,
      isNative: 0n,
      delegatedAmount: 0n,
      closeAuthorityOption: 0,
      closeAuthority: PublicKey.default,
    },
    data
  );
  const accounts = new Map([
    [
      firstPosition.toBase58(),
      {
        owner: CP_AMM_PROGRAM_ID,
        data: Buffer.alloc(408),
        lamports: 1,
        executable: false,
        rentEpoch: 0,
      },
    ],
    [
      firstNft.toBase58(),
      { owner: TOKEN_PROGRAM_ID, data, lamports: 1, executable: false, rentEpoch: 0 },
    ],
    [
      secondPosition.toBase58(),
      {
        owner: PublicKey.default,
        data: Buffer.alloc(0),
        lamports: 1,
        executable: false,
        rentEpoch: 0,
      },
    ],
    [
      secondNft.toBase58(),
      {
        owner: PublicKey.default,
        data: Buffer.alloc(0),
        lamports: 1,
        executable: false,
        rentEpoch: 0,
      },
    ],
  ]);
  const rpc = {
    getTransaction: async () => t.response,
    getMultipleAccountsInfo: async (keys: PublicKey[]) =>
      keys.map((key) => accounts.get(key.toBase58()) ?? null),
  } as unknown as Connection;
  const position = {
    pool,
    nftMint,
    unlockedLiquidity: new BN(0),
    vestedLiquidity: new BN(0),
    permanentLockedLiquidity: new BN(100),
  };
  const loaded = {
    address: pool,
    client: { _program: { coder: { accounts: { decode: () => position } } } },
  } as unknown as Awaited<ReturnType<typeof loadMigratedPool>>;
  const coin = {
    network_genesis: fixtureGenesis,
    mint: mint.toBase58(),
    dbc_pool: dbcPool.toBase58(),
    config_key: config.toBase58(),
  } as RegisteredCoin;
  expect(
    (await walletMigrationPosition(rpc, coin, collector, loaded)).position.equals(firstPosition)
  ).toBe(true);
  accounts.set(firstPosition.toBase58(), {
    owner: PublicKey.default,
    data: Buffer.alloc(0),
    lamports: 1,
    executable: false,
    rentEpoch: 0,
  });
  await expect(walletMigrationPosition(rpc, coin, collector, loaded)).rejects.toThrow(
    'Invalid company'
  );
});
