import { BorshCoder, type Idl } from '@coral-xyz/anchor';
import { type Connection, PublicKey } from '@solana/web3.js';
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, unpackAccount } from '@solana/spl-token';
import {
  DynamicBondingCurveIdl,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  derivePositionAddress,
  derivePositionNftAccount,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CP_AMM_PROGRAM_ID, type PositionState } from '@meteora-ag/cp-amm-sdk';
import bs58 from 'bs58';
import type { RegisteredCoin } from '../launchRegistry';
import { migrationHistoryBoundary, discoverMigrationBoundary } from '../migrationRegistry';
import type { loadMigratedPool } from '../damm';

/** Select only the permanently locked fee position actually created by this launch's migration. */
export async function walletMigrationPosition(
  rpc: Connection,
  coin: RegisteredCoin,
  collector: PublicKey,
  migrated: Awaited<ReturnType<typeof loadMigratedPool>>
) {
  const boundary =
    (await migrationHistoryBoundary(coin.network_genesis, coin.mint)) ??
    (await discoverMigrationBoundary(coin.network_genesis, coin.mint));
  if (!boundary) throw new Error('Retained finalized migration history is required');
  const tx = await rpc.getTransaction(boundary.signature, {
    commitment: 'finalized',
    maxSupportedTransactionVersion: 0,
  });
  if (
    !tx?.meta ||
    tx.meta.err ||
    tx.slot !== Number(boundary.slot) ||
    tx.transaction.signatures[0] !== boundary.signature
  )
    throw new Error('Canonical migration proof is unavailable');
  const definition = DynamicBondingCurveIdl.instructions.find(
    (ix) => ix.name === 'migration_damm_v2'
  );
  if (!definition) throw new Error('Missing migration ABI');
  const coder = new BorshCoder(DynamicBondingCurveIdl as unknown as Idl),
    keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta.loadedAddresses,
    });
  const instructions = [
    ...tx.transaction.message.compiledInstructions.map((ix) => ({
      programIdIndex: ix.programIdIndex,
      accounts: [...ix.accountKeyIndexes],
      data: Buffer.from(ix.data),
    })),
    ...(tx.meta.innerInstructions ?? []).flatMap((g) =>
      g.instructions.map((ix) => ({
        programIdIndex: ix.programIdIndex,
        accounts: ix.accounts,
        data: Buffer.from(bs58.decode(ix.data)),
      }))
    ),
  ];
  const candidates: Array<{ position: PublicKey; nftAccount: PublicKey; nftMint: PublicKey }> = [];
  for (const ix of instructions) {
    if (
      !keys.get(ix.programIdIndex)?.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID) ||
      coder.instruction.decode(ix.data)?.name !== definition.name
    )
      continue;
    const account = (name: string) => {
      const index = ix.accounts[definition.accounts.findIndex((a) => a.name === name)];
      const value = index === undefined ? undefined : keys.get(index);
      if (!value) throw new Error('Incomplete migration account proof');
      return value;
    };
    if (
      account('base_mint').toBase58() !== coin.mint ||
      account('config').toBase58() !== coin.config_key ||
      account('virtual_pool').toBase58() !== coin.dbc_pool ||
      !account('pool').equals(migrated.address)
    )
      continue;
    for (const prefix of ['first', 'second'])
      candidates.push({
        position: account(`${prefix}_position`),
        nftAccount: account(`${prefix}_position_nft_account`),
        nftMint: account(`${prefix}_position_nft_mint`),
      });
  }
  let selected: ((typeof candidates)[number] & { state: PositionState }) | undefined;
  for (const candidate of candidates) {
    const [info, nftInfo] = await rpc.getMultipleAccountsInfo(
      [candidate.position, candidate.nftAccount],
      'finalized'
    );
    // A zero-allocation migration candidate may remain an unused System PDA. Dust sent
    // there by a third party must not block the actual company-owned fee position.
    if (
      !nftInfo ||
      (!nftInfo.owner.equals(TOKEN_PROGRAM_ID) && !nftInfo.owner.equals(TOKEN_2022_PROGRAM_ID))
    )
      continue;
    const nft = unpackAccount(candidate.nftAccount, nftInfo, nftInfo.owner);
    if (!nft.owner.equals(collector) || nft.amount === 0n) continue;
    if (!info?.owner.equals(CP_AMM_PROGRAM_ID))
      throw new Error('Invalid company migrated position ownership');
    const position = migrated.client._program.coder.accounts.decode<PositionState>(
      'position',
      info.data
    );
    if (
      !position.pool.equals(migrated.address) ||
      !nft.mint.equals(position.nftMint) ||
      !candidate.nftMint.equals(position.nftMint) ||
      !derivePositionAddress(position.nftMint).equals(candidate.position) ||
      !derivePositionNftAccount(position.nftMint).equals(candidate.nftAccount) ||
      nft.amount !== 1n ||
      !nft.isInitialized ||
      nft.isFrozen ||
      nft.delegate ||
      nft.closeAuthority ||
      !position.unlockedLiquidity.isZero() ||
      !position.vestedLiquidity.isZero() ||
      position.permanentLockedLiquidity.lten(0)
    )
      throw new Error('Migration fee position is outside the permanent company-owned policy');
    if (selected) throw new Error('Ambiguous company migration fee position');
    selected = { ...candidate, state: position };
  }
  if (!selected) throw new Error('The company does not own the canonical migration fee position');
  return selected;
}
