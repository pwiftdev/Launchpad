import { BorshCoder, type Idl } from '@coral-xyz/anchor';
import {
  ComputeBudgetProgram,
  PublicKey,
  SystemInstruction,
  SystemProgram,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';
import {
  ASSOCIATED_TOKEN_PROGRAM_ID,
  NATIVE_MINT,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import {
  DynamicBondingCurveIdl,
  DYNAMIC_BONDING_CURVE_PROGRAM_ID,
  deriveDbcPoolAddress,
} from '@meteora-ag/dynamic-bonding-curve-sdk';
import { CpAmmIdl, CP_AMM_PROGRAM_ID } from '@meteora-ag/cp-amm-sdk';
import { getCoin, getLaunchConfig, networkGenesis, supportedConfig } from './dbc';
import { configuredVaultProgram } from './launchConfig';
import { launchIntent, registeredCoin } from './launchRegistry';
import {
  claimCommunityInstruction,
  claimCreatorInstruction,
  registerCoinInstruction,
} from '@/lib/vault/client';
import { migratedPoolAddress } from './damm';

const dbcCoder = new BorshCoder(DynamicBondingCurveIdl as unknown as Idl);
const dammCoder = new BorshCoder(CpAmmIdl as unknown as Idl);
const account = (ix: TransactionInstruction, names: readonly { name: string }[], name: string) => {
  const at = names.findIndex((a) => a.name === name),
    meta = ix.keys[at];
  if (at < 0 || !meta) throw new Error('Missing instruction account');
  return meta.pubkey;
};
type Creation = {
  mint: PublicKey;
  pool: PublicKey;
  config: PublicKey;
  mode?: 'bond' | 'creator' | 'community';
  requiresVault: boolean;
  tokenProgram: PublicKey;
};

/** The relay is a launch/trade endpoint, never an arbitrary signed-transaction RPC proxy. */
export async function validateRelayTransaction(
  tx: Transaction,
  options: { claimMint?: PublicKey } = {}
) {
  const payer = tx.feePayer;
  if (!payer) throw new Error('Missing fee payer');
  const genesis = await networkGenesis(true);
  const creations = new Map<string, Creation>(),
    tokens = new Map<string, PublicKey>();
  const validated = new Set<TransactionInstruction>(),
    registrations = new Set<string>();
  const claims = new Set<TransactionInstruction>();
  const addMint = (mint: PublicKey, program = TOKEN_PROGRAM_ID) =>
    tokens.set(mint.toBase58(), program);
  const walletPair = (input: PublicKey, output: PublicKey, mint: PublicKey, program: PublicKey) => {
    const base = getAssociatedTokenAddressSync(mint, payer, false, program),
      quote = getAssociatedTokenAddressSync(NATIVE_MINT, payer);
    if (!(
      (input.equals(base) && output.equals(quote)) ||
      (input.equals(quote) && output.equals(base))
    ))
      throw new Error('Swap token accounts must belong to the signing wallet');
  };
  addMint(NATIVE_MINT);
  for (const ix of tx.instructions) {
    if (ix.programId.equals(DYNAMIC_BONDING_CURVE_PROGRAM_ID)) {
      const decoded = dbcCoder.instruction.decode(ix.data);
      const definition = DynamicBondingCurveIdl.instructions.find((d) => d.name === decoded?.name);
      if (!definition) throw new Error('Unknown DBC instruction');
      const key = (name: string) => account(ix, definition.accounts, name);
      if (decoded?.name === 'initialize_virtual_pool_with_spl_token') {
        const mint = key('base_mint'),
          pool = key('pool'),
          config = key('config');
        if (
          !key('creator').equals(payer) ||
          !key('payer').equals(payer) ||
          !key('quote_mint').equals(NATIVE_MINT)
        )
          throw new Error('Invalid launch payer or quote mint');
        const intent = process.env.DATABASE_URL
          ? await launchIntent(genesis, mint.toBase58())
          : null;
        const approved = await getLaunchConfig(intent?.mode);
        if (
          !config.equals(approved.key) ||
          !pool.equals(deriveDbcPoolAddress(NATIVE_MINT, mint, config))
        )
          throw new Error('Launch configuration or pool differs from the prepared transaction');
        if (
          approved.record &&
          (!intent ||
            intent.deployer !== payer.toBase58() ||
            intent.config_key !== config.toBase58())
        )
          throw new Error('Signed launch intent is required');
        creations.set(pool.toBase58(), {
          mint,
          pool,
          config,
          mode: intent?.mode,
          requiresVault: approved.record?.policy_version === 'rinse-v1',
          tokenProgram: approved.config.tokenType === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID,
        });
        addMint(mint, approved.config.tokenType === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID);
        validated.add(ix);
      } else if (decoded?.name === 'swap' || decoded?.name === 'swap2') {
        const mint = key('base_mint'),
          pool = key('pool'),
          config = key('config');
        if (
          !key('payer').equals(payer) ||
          !key('quote_mint').equals(NATIVE_MINT) ||
          !(await supportedConfig(config))
        )
          throw new Error('Invalid DBC swap authority or configuration');
        const creation = creations.get(pool.toBase58());
        let tokenProgram: PublicKey;
        if (creation) {
          if (!creation.mint.equals(mint) || !creation.config.equals(config))
            throw new Error('Bundled swap differs from launch');
          tokenProgram = creation.tokenProgram;
        } else {
          const found = await getCoin(mint.toBase58());
          if (
            !found ||
            found.coin.pool !== pool.toBase58() ||
            found.coin.isMigrated ||
            !found.account.poolState.config.equals(config)
          )
            throw new Error('Unknown DBC trading pool');
          tokenProgram = found.config.tokenType === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
        }
        walletPair(key('input_token_account'), key('output_token_account'), mint, tokenProgram);
        addMint(mint, tokenProgram);
        validated.add(ix);
      } else if (decoded?.name === 'migration_damm_v2' || decoded?.name === 'create_locker') {
        const mint = key('base_mint'),
          found = await getCoin(mint.toBase58());
        if (
          !found ||
          found.coin.pool !== key('virtual_pool').toBase58() ||
          !key('payer').equals(payer) ||
          !found.account.poolState.config.equals(key('config')) ||
          found.coin.isMigrated ||
          found.account.poolState.quoteReserve.lt(found.config.migrationQuoteThreshold)
        )
          throw new Error('Launch is not ready for graduation');
        if (
          decoded.name === 'migration_damm_v2' &&
          !key('pool').equals(migratedPoolAddress(found.config, mint))
        )
          throw new Error('Wrong graduation destination');
        addMint(mint);
        validated.add(ix);
      } else throw new Error('DBC management instructions cannot use the trading relay');
    } else if (ix.programId.equals(CP_AMM_PROGRAM_ID)) {
      const decoded = dammCoder.instruction.decode(ix.data),
        definition = CpAmmIdl.instructions.find((d) => d.name === decoded?.name);
      if (!definition || (decoded?.name !== 'swap' && decoded?.name !== 'swap2'))
        throw new Error('Unknown DAMM trading instruction');
      const key = (name: string) => account(ix, definition.accounts, name);
      if (!key('payer').equals(payer)) throw new Error('Invalid DAMM swap payer');
      const a = key('token_a_mint'),
        b = key('token_b_mint');
      const mint = a.equals(NATIVE_MINT) ? b : b.equals(NATIVE_MINT) ? a : null;
      if (!mint) throw new Error('Trading relay supports SOL pairs only');
      const found = await getCoin(mint.toBase58());
      if (!found?.coin.isMigrated || found.coin.migratedPool !== key('pool').toBase58())
        throw new Error('Unknown migrated pool');
      const tokenProgram = found.config?.tokenType === 1 ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
      walletPair(key('input_token_account'), key('output_token_account'), mint, tokenProgram);
      addMint(mint, tokenProgram);
      validated.add(ix);
    }
  }
  for (const ix of tx.instructions) {
    if (validated.has(ix)) continue;
    if (
      options.claimMint &&
      !creations.size &&
      ix.programId.toBase58() === process.env.VAULT_PROGRAM_ID
    ) {
      const programId = configuredVaultProgram(),
        coin = await registeredCoin(genesis, options.claimMint.toBase58());
      if (!coin || coin.policy_version !== 'rinse-v1')
        throw new Error('Claims require a registered policy');
      let expected: TransactionInstruction | undefined;
      if (
        coin.mode === 'creator' &&
        ix.data.length === 16 &&
        coin.original_deployer === payer.toBase58()
      )
        expected = claimCreatorInstruction(
          programId,
          options.claimMint,
          payer,
          ix.data.readBigUInt64LE(8)
        );
      if (coin.mode === 'community' && ix.data.length >= 26) {
        const count = ix.data.readUInt16LE(24);
        if (count <= 32 && ix.data.length === 26 + 32 * count) {
          const proof = Array.from({ length: count }, (_, index) =>
            ix.data.subarray(26 + 32 * index, 58 + 32 * index)
          );
          expected = claimCommunityInstruction({
            programId,
            mint: options.claimMint,
            wallet: payer,
            epoch: ix.data.readBigUInt64LE(8),
            amount: ix.data.readBigUInt64LE(16),
            proof,
          });
        }
      }
      if (
        !expected ||
        !ix.data.equals(expected.data) ||
        ix.keys.length !== expected.keys.length ||
        !expected.keys.every((key, index) => ix.keys[index]?.pubkey.equals(key.pubkey))
      )
        throw new Error('Invalid claim authority or accounts');
      claims.add(ix);
      continue;
    }
    if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      // Only the standard request-units and priority-price forms; fees are paid by the signer.
      if (!(
        (ix.data[0] === 2 && ix.data.length === 5) ||
        (ix.data[0] === 3 && ix.data.length === 9)
      ))
        throw new Error('Unsupported compute budget');
      continue;
    }
    if (ix.programId.equals(ASSOCIATED_TOKEN_PROGRAM_ID)) {
      const owner = ix.keys[2]?.pubkey,
        mint = ix.keys[3]?.pubkey,
        destination = ix.keys[1]?.pubkey;
      if (
        !ix.keys[0]?.pubkey.equals(payer) ||
        !owner?.equals(payer) ||
        !mint ||
        !tokens.has(mint.toBase58()) ||
        !destination?.equals(
          getAssociatedTokenAddressSync(mint, payer, false, tokens.get(mint.toBase58()))
        ) ||
        !ix.keys[5]?.pubkey.equals(tokens.get(mint.toBase58())!) ||
        !(ix.data.length === 0 || (ix.data.length === 1 && ix.data[0] === 1))
      )
        throw new Error('Unexpected associated token account operation');
      continue;
    }
    const wrapped = getAssociatedTokenAddressSync(NATIVE_MINT, payer);
    if (ix.programId.equals(SystemProgram.programId)) {
      if (SystemInstruction.decodeInstructionType(ix) !== 'Transfer')
        throw new Error('Unsupported system instruction');
      const transfer = SystemInstruction.decodeTransfer(ix);
      if (!transfer.fromPubkey.equals(payer) || !transfer.toPubkey.equals(wrapped))
        throw new Error('Only SOL wrapping is permitted');
      continue;
    }
    if (ix.programId.equals(TOKEN_PROGRAM_ID)) {
      const sync =
        ix.data[0] === 17 &&
        ix.data.length === 1 &&
        ix.keys.length === 1 &&
        ix.keys[0]?.pubkey.equals(wrapped);
      const close =
        ix.data[0] === 9 &&
        ix.data.length === 1 &&
        ix.keys[0]?.pubkey.equals(wrapped) &&
        ix.keys[1]?.pubkey.equals(payer) &&
        ix.keys[2]?.pubkey.equals(payer);
      if (!sync && !close) throw new Error('Unsupported token instruction');
      continue;
    }
    const candidate = [...creations.values()].find((create) => {
      if (!create.requiresVault || !create.mode || create.mode === 'bond') return false;
      const expected = registerCoinInstruction({
        programId: configuredVaultProgram(),
        mint: create.mint,
        pool: create.pool,
        config: create.config,
        creator: payer,
        mode: create.mode,
      });
      return (
        ix.programId.equals(expected.programId) &&
        ix.data.equals(expected.data) &&
        ix.keys.length === expected.keys.length &&
        expected.keys.every((key, index) => ix.keys[index]?.pubkey.equals(key.pubkey))
      );
    });
    if (candidate) {
      registrations.add(candidate.pool.toBase58());
      continue;
    }
    throw new Error('Unexpected program in launch or trade transaction');
  }
  if (claims.size) {
    if (
      claims.size !== 1 ||
      tx.instructions.some(
        (ix) => !claims.has(ix) && !ix.programId.equals(ComputeBudgetProgram.programId)
      )
    )
      throw new Error('Claims cannot include additional money-moving instructions');
    if ((await networkGenesis(true)) !== genesis) throw new Error('Relay network changed');
    return;
  }
  if (!validated.size) throw new Error('Expected a known launch or trading instruction');
  for (const creation of creations.values())
    if (creation.requiresVault && !registrations.has(creation.pool.toBase58()))
      throw new Error('Atomic economic registration is required');
  if ((await networkGenesis(true)) !== genesis) throw new Error('Relay network changed');
}
