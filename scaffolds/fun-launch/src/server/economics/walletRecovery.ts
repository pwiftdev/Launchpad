import { createHash } from 'node:crypto';
import { type Connection, VersionedTransaction } from '@solana/web3.js';
import { messageDigest, validateSignedTransaction } from './chainEvidence';
import type { WalletJob } from './walletTypes';

export type WalletRecoveryProof = {
  jobId: string;
  networkGenesis: string;
  messageDigest: string;
  signature: string | null;
  preparedSlot: number;
  lastValidBlockHeight: number;
  finalizedHeight: number;
  proofSlot: number;
  blockCoverage: readonly {
    slot: number;
    blockHeight: number;
    blockhash: string;
    signaturesDigest: string;
  }[];
};
const verified = new WeakSet<object>();
export function assertWalletRecoveryProof(proof: WalletRecoveryProof): void {
  if (!verified.has(proof))
    throw new Error('Independent positive wallet expiry evidence is required');
}
const safe = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
/** Standard transfers have no custom receipt marker: missing status alone can never authorize repayment. */
export async function verifyWalletRecovery(
  rpc: Connection,
  job: WalletJob
): Promise<WalletRecoveryProof> {
  const deadline = performance.now() + 30000;
  const withinDeadline = () => {
    if (performance.now() > deadline)
      throw new Error(
        'Bounded wallet recovery timed out; keep the original attempt and reservation'
      );
  };
  if (
    !job.transaction_base64 ||
    !job.message_digest ||
    job.prepared_slot === null ||
    job.last_valid_block_height === null ||
    !['prepared', 'signed', 'submitted', 'manual_review'].includes(job.status) ||
    (await rpc.getGenesisHash()) !== job.network_genesis
  )
    throw new Error('Prepared wallet identity and network are required for recovery');
  const tx = VersionedTransaction.deserialize(Buffer.from(job.transaction_base64, 'base64'));
  if (messageDigest(tx.message.serialize()) !== job.message_digest)
    throw new Error('Stored wallet message changed');
  if (
    job.signature &&
    validateSignedTransaction(job.transaction_base64, job.message_digest).signature !==
      job.signature
  )
    throw new Error('Stored signature differs from the expired wallet attempt');
  if (!job.signature && tx.signatures.some((s) => s.some((b) => b !== 0)))
    throw new Error('Signed bytes require a stored signature before recovery');
  const preparedSlot = Number(job.prepared_slot),
    lastValidBlockHeight = Number(job.last_valid_block_height);
  const bank = await rpc.getEpochInfo({ commitment: 'finalized', minContextSlot: preparedSlot });
  if (
    !safe(preparedSlot) ||
    !safe(lastValidBlockHeight) ||
    !safe(bank.blockHeight) ||
    !safe(bank.absoluteSlot) ||
    bank.absoluteSlot < preparedSlot ||
    bank.blockHeight <= lastValidBlockHeight
  )
    throw new Error('The prepared wallet attempt has not positively expired at finality');
  const [finalized, confirmed] = await Promise.all([
    rpc.isBlockhashValid(tx.message.recentBlockhash, {
      commitment: 'finalized',
      minContextSlot: bank.absoluteSlot,
    }),
    rpc.isBlockhashValid(tx.message.recentBlockhash, {
      commitment: 'confirmed',
      minContextSlot: bank.absoluteSlot,
    }),
  ]);
  if (
    !safe(finalized.context.slot) ||
    !safe(confirmed.context.slot) ||
    finalized.context.slot < bank.absoluteSlot ||
    confirmed.context.slot < bank.absoluteSlot ||
    finalized.value ||
    confirmed.value
  )
    throw new Error('The original wallet blockhash is still usable');
  const coverage: Array<{
    slot: number;
    blockHeight: number;
    blockhash: string;
    signaturesDigest: string;
  }> = [];
  if (job.signature) {
    withinDeadline();
    const signature = job.signature;
    const [status, receipt, firstAvailable] = await Promise.all([
      rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }),
      rpc.getTransaction(signature, { commitment: 'finalized', maxSupportedTransactionVersion: 0 }),
      rpc.getFirstAvailableBlock(),
    ]);
    if (status.value[0] || receipt)
      throw new Error('Reconcile the observed wallet attempt before recovery');
    if (!safe(firstAvailable) || firstAvailable > preparedSlot)
      throw new Error('Retained wallet preparation history is unavailable; keep the reservation');
    const slots = await rpc.getBlocks(
      preparedSlot,
      Math.min(bank.absoluteSlot, preparedSlot + 4096),
      'finalized'
    );
    if (
      !slots.length ||
      slots[0] !== preparedSlot ||
      slots.some((s, i) => !safe(s) || s > bank.absoluteSlot || (i > 0 && s <= slots[i - 1]!))
    )
      throw new Error('Complete canonical wallet block coverage is unavailable');
    let previous: { slot: number; height: number; hash: string } | undefined,
      proved = false;
    for (const slot of slots.slice(0, 512)) {
      withinDeadline();
      const [header, signatures] = await Promise.all([
        rpc.getBlock(slot, {
          commitment: 'finalized',
          transactionDetails: 'none',
          rewards: false,
          maxSupportedTransactionVersion: 0,
        }),
        rpc.getBlockSignatures(slot, 'finalized'),
      ]);
      const height = (header as { blockHeight?: unknown } | null)?.blockHeight;
      withinDeadline();
      if (
        !header ||
        !safe(height) ||
        !signatures ||
        header.blockhash !== signatures.blockhash ||
        header.parentSlot !== signatures.parentSlot ||
        header.previousBlockhash !== signatures.previousBlockhash ||
        signatures.signatures.length > 10000 ||
        new Set(signatures.signatures).size !== signatures.signatures.length ||
        (previous &&
          (height !== previous.height + 1 ||
            header.parentSlot !== previous.slot ||
            header.previousBlockhash !== previous.hash)) ||
        (!previous && height > lastValidBlockHeight)
      )
        throw new Error(
          'Missing or inconsistent finalized wallet block history; keep the reservation'
        );
      if (signatures.signatures.includes(signature))
        throw new Error('Wallet signature was found in retained history; reconcile it');
      coverage.push(
        Object.freeze({
          slot,
          blockHeight: height,
          blockhash: header.blockhash,
          signaturesDigest: createHash('sha256')
            .update(JSON.stringify(signatures.signatures))
            .digest('hex'),
        })
      );
      previous = { slot, height: height, hash: header.blockhash };
      if (height > lastValidBlockHeight) {
        proved = true;
        break;
      }
    }
    if (!proved)
      throw new Error(
        'Bounded history did not cover the full wallet validity window; keep the reservation'
      );
  }
  const after = await rpc.getEpochInfo({
    commitment: 'finalized',
    minContextSlot: bank.absoluteSlot,
  });
  if (
    !safe(after.blockHeight) ||
    !safe(after.absoluteSlot) ||
    after.blockHeight < bank.blockHeight ||
    after.absoluteSlot < bank.absoluteSlot
  )
    throw new Error('Wallet expiry finalized bank regressed');
  const [afterFinalized, afterConfirmed] = await Promise.all([
    rpc.isBlockhashValid(tx.message.recentBlockhash, {
      commitment: 'finalized',
      minContextSlot: after.absoluteSlot,
    }),
    rpc.isBlockhashValid(tx.message.recentBlockhash, {
      commitment: 'confirmed',
      minContextSlot: after.absoluteSlot,
    }),
  ]);
  if (
    !safe(after.blockHeight) ||
    !safe(after.absoluteSlot) ||
    after.blockHeight < bank.blockHeight ||
    after.absoluteSlot < bank.absoluteSlot ||
    afterFinalized.value ||
    afterConfirmed.value ||
    !safe(afterFinalized.context.slot) ||
    !safe(afterConfirmed.context.slot) ||
    afterFinalized.context.slot < after.absoluteSlot ||
    afterConfirmed.context.slot < after.absoluteSlot ||
    (await rpc.getGenesisHash()) !== job.network_genesis
  )
    throw new Error('Wallet expiry network or finalized bank changed');
  if (job.signature) {
    const status = await rpc.getSignatureStatuses([job.signature], {
      searchTransactionHistory: true,
    });
    if (status.value[0])
      throw new Error('Wallet attempt became observable; reconcile before recovery');
  }
  const proof: WalletRecoveryProof = Object.freeze({
    jobId: job.id,
    networkGenesis: job.network_genesis,
    messageDigest: job.message_digest,
    signature: job.signature,
    preparedSlot,
    lastValidBlockHeight,
    finalizedHeight: after.blockHeight,
    proofSlot: after.absoluteSlot,
    blockCoverage: Object.freeze(coverage),
  });
  withinDeadline();
  verified.add(proof);
  return proof;
}
