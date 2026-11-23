import { PublicKey, Transaction, type Connection } from '@solana/web3.js';
import { claimPlatformInstruction, vaultAddresses } from '@/lib/vault/client';
import { decodeVaultCoin, decodeVaultSettings } from '@/lib/vault/state';
import { registeredCoin, registeredConfig } from '../launchRegistry';
import { assertFinalizedClock, type FinalizedClock } from './chainEvidence';
import type { FinancialStore, PreparedExecution } from './financialStore';

/** Private operator preparation only. No key loading, signing, relay or public API. */
export async function preparePlatformWithdrawal(args: {
  rpc: Connection;
  store: Pick<FinancialStore, 'balances'>;
  programId: PublicKey;
  mint: PublicKey;
  networkGenesis: string;
  amount: bigint;
  clock: FinalizedClock;
}): Promise<PreparedExecution> {
  assertFinalizedClock(args.clock);
  if (
    args.clock.networkGenesis !== args.networkGenesis ||
    (await args.rpc.getGenesisHash()) !== args.networkGenesis
  )
    throw new Error('Platform preparation network mismatch');
  if (args.amount <= 0n || args.amount > (1n << 64n) - 1n)
    throw new Error('Invalid platform withdrawal amount');
  const identity = await registeredCoin(args.networkGenesis, args.mint.toBase58());
  if (!identity || identity.policy_version !== 'rinse-v1')
    throw new Error('Immutable reviewed coin is required');
  const config = await registeredConfig(args.networkGenesis, identity.config_key);
  if (!config || config.policy_version !== 'rinse-v1')
    throw new Error('Immutable reviewed config is required');
  const addresses = vaultAddresses(args.programId, args.mint),
    response = await args.rpc.getMultipleAccountsInfoAndContext(
      [args.programId, addresses.settings, addresses.coin],
      { commitment: 'finalized' }
    );
  const [program, settingsAccount, coinAccount] = response.value;
  if (
    !program?.executable ||
    !settingsAccount?.owner.equals(args.programId) ||
    !coinAccount?.owner.equals(args.programId) ||
    settingsAccount.data.length !== 107 ||
    coinAccount.data.length !== 347
  )
    throw new Error('Invalid native platform custody accounts');
  const settings = decodeVaultSettings(settingsAccount.data),
    coin = decodeVaultCoin(coinAccount.data);
  const treasury = new PublicKey(config.expected_leftover_receiver);
  if (
    !settings.treasury.equals(treasury) ||
    !PublicKey.isOnCurve(treasury.toBytes()) ||
    !coin.mint.equals(args.mint) ||
    coin.pool.toBase58() !== identity.dbc_pool ||
    coin.config.toBase58() !== identity.config_key ||
    coin.creator.toBase58() !== identity.original_deployer ||
    coin.mode !== identity.mode ||
    coin.activationTime !== BigInt(identity.activation_point) ||
    coin.configHash !== config.config_digest
  )
    throw new Error('Platform recipient or native identity differs from immutable policy');
  const balances = await args.store.balances(args.networkGenesis, args.mint.toBase58()),
    balance = balances.find((row) => row.bucket === 'platform');
  const funded = BigInt(balance?.funded ?? '0'),
    spent = BigInt(balance?.spent ?? '0'),
    reserved = BigInt(balance?.reserved ?? '0');
  if (
    spent > funded ||
    reserved < 0n ||
    coin.platformFees !== funded - spent ||
    args.amount > funded - spent - reserved
  )
    throw new Error('Reconcile native platform custody with the funded journal before withdrawal');
  const instruction = claimPlatformInstruction(args.programId, args.mint, treasury, args.amount),
    latest = await args.rpc.getLatestBlockhash('finalized');
  const transaction = new Transaction({
    feePayer: treasury,
    recentBlockhash: latest.blockhash,
  }).add(instruction);
  return {
    networkGenesis: args.networkGenesis,
    mint: args.mint.toBase58(),
    kind: 'platform_claim',
    intentKey: `platform:${treasury.toBase58()}:${coin.platformFees}:${args.clock.slot}`,
    lamports: args.amount,
    recipient: treasury.toBase58(),
    transactionBase64: transaction
      .serialize({ requireAllSignatures: false, verifySignatures: false })
      .toString('base64'),
    lastValidBlockHeight: latest.lastValidBlockHeight,
    clock: args.clock,
    expectation: {
      program: args.programId.toBase58(),
      accounts: instruction.keys.map((key) => key.pubkey.toBase58()),
      dataBase64: instruction.data.toString('base64'),
      vault: addresses.coin.toBase58(),
      effect: 'sol_claim',
    },
  };
}
