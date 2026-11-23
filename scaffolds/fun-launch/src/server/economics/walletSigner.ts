import { isWalletPolicy } from '@/lib/launchModes';
import { Transaction, type Connection } from '@solana/web3.js';
import { registeredCoin } from '../launchRegistry';
import { messageDigest, validateSignedTransaction } from './chainEvidence';
import { signerExchange, type ExternalSignerCommand } from './externalSigner';
import { assertWalletExecutionGate } from './walletGate';
import { MeteoraWalletAdapter } from './walletAdapter';
import { WALLET_MEMO_PROGRAM } from './walletEvidence';
import { WalletStore } from './walletStore';
import type { WalletJob, WalletSigner } from './walletTypes';
import { MINIMUM_BUYBACK_LAMPORTS } from './walletPolicy';

export type WalletSigningLimits = {
  maximumBuybackLamports: string;
  maximumPayoutLamports: string;
  maximumOperatingCostLamports: string;
};
export const WALLET_SIGN_PROTOCOL = 'rinsed-wallet-sign-v1';
const number = (value: unknown) => {
  if (
    typeof value !== 'string' ||
    !/^\d+$/.test(value) ||
    BigInt(value) <= 0n ||
    BigInt(value) > 18446744073709551615n
  )
    throw new Error('Invalid signer monetary bound');
  return BigInt(value);
};
function normalizedInstructions(tx: Transaction) {
  const message = tx.compileMessage(),
    keys = message.accountKeys;
  return message.instructions
    .filter((ix) => !keys[ix.programIdIndex]!.equals(WALLET_MEMO_PROGRAM))
    .map((ix) => ({
      program: keys[ix.programIdIndex]!.toBase58(),
      data: ix.data,
      accounts: ix.accounts.map((index) => ({
        key: keys[index]!.toBase58(),
        signer: message.isAccountSigner(index),
        writable: message.isAccountWritable(index),
      })),
    }));
}
/** Independent signer-side database, destination, budget and instruction reconstruction. */
export async function validateWalletSignJob(
  job: WalletJob,
  rpc: Connection,
  store: WalletStore,
  limits: WalletSigningLimits
) {
  const wallets = await assertWalletExecutionGate(rpc, job.network_genesis, { worker: true }),
    saved = await store.job(job.id);
  const boundKeys: Array<keyof WalletJob> = [
    'id',
    'network_genesis',
    'mint',
    'kind',
    'bucket',
    'recipient',
    'epoch',
    'lamports',
    'transaction_base64',
    'message_digest',
    'prepared_slot',
    'last_valid_block_height',
  ];
  if (
    !saved ||
    saved.status !== 'prepared' ||
    saved.signature ||
    boundKeys.some((key) => saved[key] !== job[key]) ||
    JSON.stringify(saved.expectations) !== JSON.stringify(job.expectations) ||
    !job.transaction_base64 ||
    !job.message_digest ||
    !job.last_valid_block_height
  )
    throw new Error('Signer request differs from the durable unsigned wallet job');
  await store.assertNoUnsettledSigned(job.network_genesis, wallets.collector.toBase58(), job.id);
  const bytes = Buffer.from(job.transaction_base64, 'base64'),
    tx = Transaction.from(bytes);
  if (
    bytes.length > 1232 ||
    bytes.toString('base64') !== job.transaction_base64 ||
    messageDigest(tx.serializeMessage()) !== job.message_digest ||
    tx.compileMessage().header.numRequiredSignatures !== 1 ||
    !tx.feePayer?.equals(wallets.collector) ||
    tx.signatures.some((s) => s.signature !== null)
  )
    throw new Error('Signer requires an exact unsigned company-wallet transaction');
  const operating = number(job.expectations.operatingCostLamports),
    maximumOperating = number(limits.maximumOperatingCostLamports);
  const temporaryValue = job.expectations.temporaryFundingLamports ?? '0';
  if (
    typeof temporaryValue !== 'string' ||
    !/^\d{1,20}$/.test(temporaryValue) ||
    BigInt(temporaryValue) > 18446744073709551615n
  )
    throw new Error('Invalid temporary account funding bound');
  const cashRequired = operating + BigInt(temporaryValue);
  if (operating > maximumOperating) throw new Error('Signer operating budget exceeded');
  if (job.kind === 'buyback' && number(job.lamports) > number(limits.maximumBuybackLamports))
    throw new Error('Signer buyback limit exceeded');
  if (job.kind === 'buyback' && number(job.lamports) < MINIMUM_BUYBACK_LAMPORTS)
    throw new Error('Signer buyback is below the 0.025 SOL minimum');
  if (job.kind.endsWith('_claim') && number(job.lamports) > number(limits.maximumPayoutLamports))
    throw new Error('Signer payout limit exceeded');
  const coin = await registeredCoin(job.network_genesis, job.mint);
  if (!coin || !isWalletPolicy(coin.policy_version))
    throw new Error('Signer requires an immutable wallet launch');
  // The transport intentionally omits details; only the durable row supplies the funding route.
  if (coin.policy_version === 'bond-v1') await store.assertOperatingFunding(saved);
  const slippage = job.kind === 'buyback' ? Number(job.expectations.slippageBps) : 100;
  if (!Number.isInteger(slippage) || slippage < 1 || slippage > 100)
    throw new Error('Signer buyback slippage exceeds the private execution policy');
  const adapter = new MeteoraWalletAdapter(rpc, job.network_genesis, wallets.collector, slippage);
  const collectionEvents = job.kind === 'collect' ? await store.collectionEvents(job) : [];
  const rebuilt =
    job.kind === 'collect'
      ? await adapter.prepareCollection({
          coin,
          events: collectionEvents,
          maximumQuoteLamports: collectionEvents.reduce((sum, event) => sum + event.net, 0n),
        })
      : job.kind === 'buyback'
        ? await adapter.prepareBuyback(
            { coin, maximumSpendLamports: BigInt(job.lamports) },
            number(job.expectations.burnTokens)
          )
        : job.kind === 'setup'
          ? await adapter.prepareSetup({ coin })
          : await adapter.preparePayout(job);
  const expected = Transaction.from(Buffer.from(rebuilt.transactionBase64, 'base64'));
  const memos = tx.instructions.filter((ix) => ix.programId.equals(WALLET_MEMO_PROGRAM));
  if (
    memos.length !== 1 ||
    memos[0]!.keys.length !== 0 ||
    memos[0]!.data.toString('utf8') !== job.expectations.memo ||
    !/^RINSED:[a-f0-9-]{36}$/.test(memos[0]!.data.toString('utf8')) ||
    JSON.stringify(normalizedInstructions(tx)) !== JSON.stringify(normalizedInstructions(expected))
  )
    throw new Error('Signer refused instructions outside the reconstructed Meteora settlement');
  const preparedSlot = Number(job.prepared_slot),
    lastValidHeight = Number(job.last_valid_block_height);
  if (
    !Number.isSafeInteger(preparedSlot) ||
    preparedSlot < 0 ||
    !Number.isSafeInteger(lastValidHeight) ||
    lastValidHeight < 0
  )
    throw new Error('Invalid prepared wallet validity bounds');
  const bank = await rpc.getEpochInfo({ commitment: 'finalized', minContextSlot: preparedSlot });
  const hash = await rpc.isBlockhashValid(tx.recentBlockhash!, {
    commitment: 'confirmed',
    minContextSlot: Math.max(preparedSlot, bank.absoluteSlot),
  });
  if (
    typeof bank.blockHeight !== 'number' ||
    !Number.isSafeInteger(bank.blockHeight) ||
    !Number.isSafeInteger(bank.absoluteSlot) ||
    bank.absoluteSlot < preparedSlot ||
    bank.blockHeight > lastValidHeight ||
    !hash.value ||
    !Number.isSafeInteger(hash.context.slot) ||
    hash.context.slot < bank.absoluteSlot
  )
    throw new Error('Signer requires a live prepared blockhash');
  const requirement = await store.custodyRequirement(
    job.network_genesis,
    wallets.collector.toBase58()
  );
  const cash = await rpc.getBalanceAndContext(wallets.collector, {
    commitment: 'finalized',
    minContextSlot: requirement.minimumSlot,
  });
  const totalOperating =
    requirement.operating > cashRequired ? requirement.operating : cashRequired;
  if (
    !Number.isSafeInteger(cash.value) ||
    cash.context.slot < requirement.minimumSlot ||
    BigInt(cash.value) < requirement.liability + totalOperating
  )
    throw new Error(
      'Company operating funds do not cover all reward liabilities and execution costs'
    );
  await assertWalletExecutionGate(rpc, job.network_genesis, { worker: true });
  await store.assertNoUnsettledSigned(job.network_genesis, wallets.collector.toBase58(), job.id);
  return { transaction: tx, collector: wallets.collector };
}

/** The unsigned worker uses a bounded external sign-only process; it never reads a private key. */
export class WalletExternalSigner implements WalletSigner {
  constructor(
    private readonly rpc: Connection,
    private readonly genesis: string,
    private readonly command: ExternalSignerCommand
  ) {}
  async sign(job: WalletJob) {
    if (job.network_genesis !== this.genesis || job.status !== 'prepared' || !job.message_digest)
      throw new Error('Unsigned wallet job required');
    await assertWalletExecutionGate(this.rpc, this.genesis, { worker: true });
    const result = await signerExchange(this.command, {
      protocol: WALLET_SIGN_PROTOCOL,
      job: { ...job, details: {} },
    });
    if (!result || typeof result !== 'object' || Array.isArray(result))
      throw new Error('Invalid wallet signer response');
    const response = result as Record<string, unknown>;
    if (
      Object.keys(response).some(
        (k) =>
          !['protocol', 'jobId', 'messageDigest', 'signedTransactionBase64', 'signature'].includes(
            k
          )
      ) ||
      response.protocol !== WALLET_SIGN_PROTOCOL ||
      response.jobId !== job.id ||
      response.messageDigest !== job.message_digest ||
      typeof response.signedTransactionBase64 !== 'string'
    )
      throw new Error('Wallet signer response identity mismatch');
    const signed = validateSignedTransaction(response.signedTransactionBase64, job.message_digest);
    if (signed.signature !== response.signature)
      throw new Error('Wallet signer signature mismatch');
    return {
      signedTransactionBase64: response.signedTransactionBase64,
      signature: signed.signature,
    };
  }
}
