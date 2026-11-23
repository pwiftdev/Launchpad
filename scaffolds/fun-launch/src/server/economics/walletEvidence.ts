import { Connection, PublicKey, SystemProgram, VersionedTransaction } from '@solana/web3.js';
import { createTransferCheckedInstruction, createAssociatedTokenAccountIdempotentInstruction, getAssociatedTokenAddressSync, NATIVE_MINT, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  actualBurnedTokens,
  allInstructions,
  assertFinalizedEvidence,
  lamportDelta,
  messageDigest,
  purchasedTokens,
  requireInstruction,
  tokenDelta,
  type FinalizedEvidence,
} from './chainEvidence';
import type { WalletEffectFacts, WalletJob } from './walletTypes';

export const WALLET_MEMO_PROGRAM = new PublicKey('MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr');
const verified = new WeakSet<object>();
export function assertVerifiedWalletEffect(facts: WalletEffectFacts): void {
  if (!verified.has(facts)) throw new Error('An independently verified wallet effect is required');
}
function balance(e: FinalizedEvidence, address: string, post = false): bigint {
  const tx = e.transaction,
    keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta!.loadedAddresses,
    });
  for (let i = 0; i < keys.length; i++)
    if (keys.get(i)?.toBase58() === address) {
      const n = (post ? tx.meta!.postBalances : tx.meta!.preBalances)[i];
      if (!Number.isSafeInteger(n) || n! < 0) throw new Error('Unsafe wallet balance');
      return BigInt(n!);
    }
  throw new Error('Missing wallet balance account');
}
function quoteTransfers(e: FinalizedEvidence, source: string, destination: string, mint: string): bigint {
  const tx = e.transaction,
    keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta!.loadedAddresses,
    });
  const sourceBalance = [
    ...(tx.meta!.preTokenBalances ?? []),
    ...(tx.meta!.postTokenBalances ?? []),
  ].find((b) => keys.get(b.accountIndex)?.toBase58() === source);
  if (sourceBalance?.mint !== mint)
    throw new Error('Fee source has an unexpected mint');
  return allInstructions(e).reduce((sum, ix) => {
    if (ix.program !== TOKEN_PROGRAM_ID.toBase58()) return sum;
    if (
      ix.data.length === 9 &&
      ix.data[0] === 3 &&
      ix.accounts[0] === source &&
      ix.accounts[1] === destination
    )
      return sum + ix.data.readBigUInt64LE(1);
    if (
      ix.data.length === 10 &&
      ix.data[0] === 12 &&
      ix.accounts[0] === source &&
      ix.accounts[1] === mint &&
      ix.accounts[2] === destination
    )
      return sum + ix.data.readBigUInt64LE(1);
    return sum;
  }, 0n);
}
function requiredString(job: WalletJob, key: string) {
  const value = job.expectations[key];
  if (typeof value !== 'string' || !value) throw new Error(`Missing wallet expectation: ${key}`);
  return value;
}

/** Cash, token and canonical block-order proof. A successful signature alone never funds rewards. */
export async function verifyWalletEffect(
  rpc: Connection,
  job: WalletJob,
  evidence: FinalizedEvidence
): Promise<WalletEffectFacts> {
  assertFinalizedEvidence(evidence);
  if (
    !job.transaction_base64 ||
    !job.message_digest ||
    job.signature !== evidence.signature ||
    job.network_genesis !== evidence.networkGenesis ||
    job.message_digest !== evidence.messageDigest ||
    (await rpc.getGenesisHash()) !== job.network_genesis
  )
    throw new Error('Wallet receipt identity mismatch');
  const saved = VersionedTransaction.deserialize(Buffer.from(job.transaction_base64, 'base64'));
  const collector = requiredString(job, 'collector'),
    tx = evidence.transaction;
  if (
    messageDigest(saved.message.serialize()) !== evidence.messageDigest ||
    saved.message.header.numRequiredSignatures !== 1 ||
    saved.message.staticAccountKeys[0]?.toBase58() !== collector
  )
    throw new Error('Wallet execution must have the reviewed collector as its only signer');
  const instructions = allInstructions(evidence),
    top = instructions.filter((ix) => ix.eventIndex === 0);
  const memos = top.filter((ix) => ix.program === WALLET_MEMO_PROGRAM.toBase58());
  if (memos.length !== 1 || memos[0]!.data.toString('utf8') !== requiredString(job, 'memo'))
    throw new Error('Missing unique wallet execution memo');
  if (
    !Number.isSafeInteger(tx.meta!.fee) ||
    tx.meta!.fee < 0 ||
    BigInt(tx.meta!.fee) > BigInt(requiredString(job, 'maximumFeeLamports'))
  )
    throw new Error('Wallet transaction fee exceeds its operating budget');
  const fee = BigInt(tx.meta!.fee),
    delta = lamportDelta(evidence, collector);
  const facts: Omit<WalletEffectFacts, 'transactionIndex' | 'slotSignatures'> = {
    kind: job.kind,
    networkGenesis: job.network_genesis,
    mint: job.mint,
    signature: evidence.signature,
    slot: evidence.slot,
    messageDigest: evidence.messageDigest,
    evidence,
    operatingCostLamports: fee,
  };
  const quoteMint = new PublicKey(String(job.expectations.quoteMint ?? NATIVE_MINT));
  const spl = !quoteMint.equals(NATIVE_MINT);
  if (job.kind.endsWith('_claim') && spl) {
    const owner = new PublicKey(collector);
    const recipient = new PublicKey(requiredString(job, 'recipient'));
    const amount = BigInt(requiredString(job, 'expectedLamports'));
    if (amount <= 0n || amount !== BigInt(job.lamports) || recipient.toBase58() !== job.recipient) throw new Error('Invalid SPL payout liability');
    const source = getAssociatedTokenAddressSync(quoteMint, owner);
    const destination = getAssociatedTokenAddressSync(quoteMint, recipient);
    const rent = lamportDelta(evidence, destination.toBase58());
    if (rent < 0n || fee + rent > BigInt(requiredString(job, 'operatingCostLamports')) || delta !== -fee-rent || top.length !== 3) throw new Error('Unexpected SPL payout cost');
    for (const instruction of [createAssociatedTokenAccountIdempotentInstruction(owner, destination, recipient, quoteMint), createTransferCheckedInstruction(source, quoteMint, destination, owner, amount, 9)]) {
      const proven = requireInstruction(evidence, { program: instruction.programId.toBase58(), accounts: instruction.keys.map(k => k.pubkey.toBase58()), data: instruction.data });
      if (proven.eventIndex !== 0) throw new Error('Expected a direct SPL payout');
    }
    const debit = owner.equals(recipient) ? 0n : amount;
    if (tokenDelta(evidence, source.toBase58(), quoteMint.toBase58()) !== -debit || tokenDelta(evidence, destination.toBase58(), quoteMint.toBase58()) !== debit) throw new Error('SPL payout balance mismatch');
    Object.assign(facts, { recipient: job.recipient, paidLamports: amount, collectorDebitLamports: debit, operatingCostLamports: fee + rent });
  } else if (job.kind.endsWith('_claim')) {
    const recipient = requiredString(job, 'recipient'),
      amount = BigInt(requiredString(job, 'expectedLamports'));
    if (amount <= 0n || amount !== BigInt(job.lamports) || recipient !== job.recipient)
      throw new Error('Payout liability changed');
    const expected = SystemProgram.transfer({
      fromPubkey: new PublicKey(collector),
      toPubkey: new PublicKey(recipient),
      lamports: amount,
    });
    if (
      top.length !== 2 ||
      top.filter(
        (ix) =>
          ix.program === expected.programId.toBase58() &&
          ix.data.equals(expected.data) &&
          ix.accounts.length === expected.keys.length &&
          ix.accounts.every((key, i) => key === expected.keys[i]!.pubkey.toBase58())
      ).length !== 1
    )
      throw new Error('Payout differs from its immutable beneficiary');
    if (
      delta !== -fee - (recipient === collector ? 0n : amount) ||
      (recipient !== collector && lamportDelta(evidence, recipient) !== amount)
    )
      throw new Error('Payout cash does not match liability');
    Object.assign(facts, {
      recipient,
      paidLamports: amount,
      collectorDebitLamports: recipient === collector ? 0n : amount,
    });
  } else {
    const quote = requiredString(job, 'quoteAta'),
      token = requiredString(job, 'tokenAta');
    const tokenRent = lamportDelta(evidence, token);
    if (tokenRent < 0n || tokenRent > BigInt(requiredString(job, 'operatingCostLamports')))
      throw new Error('Unexpected token account funding');
    if (job.kind === 'setup') {
      if (spl && tokenDelta(evidence, quote, quoteMint.toBase58()) !== 0n) throw new Error('Unexpected quote movement during setup');
      const quoteRent = lamportDelta(evidence, quote);
      facts.operatingCostLamports = fee + tokenRent + quoteRent;
      if (
        quoteRent < 0n ||
        tokenRent + quoteRent + fee > BigInt(requiredString(job, 'operatingCostLamports')) ||
        delta !== -fee - tokenRent - quoteRent ||
        tokenDelta(evidence, token, job.mint) !== 0n
      )
        throw new Error('Unexpected setup cash or token movement');
    } else {
      facts.operatingCostLamports = fee + tokenRent;
      const expected = job.expectations.instruction as
        { program?: string; accounts?: string[]; dataBase64?: string } | undefined;
      if (!expected?.program || !Array.isArray(expected.accounts) || !expected.dataBase64)
        throw new Error('Missing reviewed Meteora instruction');
      const dexInstruction = requireInstruction(evidence, {
        program: expected.program,
        accounts: expected.accounts,
        data: Buffer.from(expected.dataBase64, 'base64'),
      });
      if (dexInstruction.eventIndex !== 0)
        throw new Error('Meteora settlement must be a direct collector instruction');
      if (!spl && balance(evidence, quote, true) !== 0n)
        throw new Error('Wrapped SOL was not returned to the collector');
      const closes = instructions.filter(
        (ix) =>
          ix.program === TOKEN_PROGRAM_ID.toBase58() &&
          ix.data.length === 1 &&
          ix.data[0] === 9 &&
          ix.accounts[0] === quote &&
          ix.accounts[1] === collector &&
          ix.accounts[2] === collector
      );
      if (closes.length !== (spl ? 0 : 1)) throw new Error('Expected exactly one collector wrapped SOL close');
      const previousQuoteBalance = balance(evidence, quote);
      if (job.kind === 'collect') {
        const received = quoteTransfers(evidence, requiredString(job, 'sourceQuoteVault'), quote, quoteMint.toBase58());
        const quoteRent = spl ? lamportDelta(evidence, quote) : 0n;
        if (quoteRent < 0n || (spl && fee + tokenRent + quoteRent > BigInt(requiredString(job,'operatingCostLamports')))) throw new Error('Unexpected SPL collection rent');
        facts.operatingCostLamports = fee + tokenRent + quoteRent;
        if (
          received <= 0n ||
          (spl ? delta !== -fee-tokenRent-quoteRent || tokenDelta(evidence, quote, quoteMint.toBase58()) !== received : delta + fee + tokenRent - previousQuoteBalance !== received) ||
          tokenDelta(evidence, token, job.mint) !== 0n
        )
          throw new Error('Collected cash does not match finalized quote-only fee transfers');
        if (
          job.expectations.route === 'dbc' &&
          received !== BigInt(requiredString(job, 'expectedLamports'))
        )
          throw new Error('DBC collection differs from the reserved fee events');
        Object.assign(facts, { receivedLamports: received });
      } else if (job.kind === 'buyback' && !spl) {
        // The source WSOL ATA is created and closed in one transaction, so validate the destination vault's mint instead.
        const spent = nativeTransfersFromClosedAccount(
          evidence,
          quote,
          requiredString(job, 'sourceQuoteVault')
        );
        const burn = BigInt(requiredString(job, 'burnTokens'));
        if (
          spent <= 0n ||
          spent > BigInt(requiredString(job, 'maximumSpendLamports')) ||
          -delta - fee - tokenRent + previousQuoteBalance !== spent ||
          burn <= 0n ||
          purchasedTokens(evidence, requiredString(job, 'sourceTokenVault'), token, job.mint) !==
            burn ||
          actualBurnedTokens(evidence, token, job.mint, collector) !== burn ||
          tokenDelta(evidence, token, job.mint) !== 0n
        )
          throw new Error('Buyback spend, purchase and burn do not match');
        Object.assign(facts, { burnedTokens: burn, collectorDebitLamports: spent });
      } else throw new Error('Unsupported wallet effect');
    }
  }
  const block = await rpc.getBlockSignatures(evidence.slot, 'finalized');
  if (
    !block ||
    block.signatures.length > 10000 ||
    block.signatures.filter((s) => s === evidence.signature).length !== 1 ||
    (await rpc.getGenesisHash()) !== job.network_genesis
  )
    throw new Error('Canonical finalized execution order is unavailable');
  const result: WalletEffectFacts = Object.freeze({
    ...facts,
    transactionIndex: block.signatures.indexOf(evidence.signature),
    slotSignatures: Object.freeze([...block.signatures]),
  });
  verified.add(result);
  return result;
}

function nativeTransfersFromClosedAccount(
  e: FinalizedEvidence,
  source: string,
  destination: string
): bigint {
  // Reverse the validation direction without reversing the actual transfer direction.
  const tx = e.transaction,
    keys = tx.transaction.message.getAccountKeys({
      accountKeysFromLookups: tx.meta!.loadedAddresses,
    });
  if (
    ![...(tx.meta!.preTokenBalances ?? []), ...(tx.meta!.postTokenBalances ?? [])].some(
      (b) =>
        keys.get(b.accountIndex)?.toBase58() === destination && b.mint === NATIVE_MINT.toBase58()
    )
  )
    throw new Error('Spend destination is not wrapped SOL');
  return allInstructions(e).reduce((sum, ix) => {
    if (ix.program !== TOKEN_PROGRAM_ID.toBase58()) return sum;
    if (
      ix.data[0] === 3 &&
      ix.data.length === 9 &&
      ix.accounts[0] === source &&
      ix.accounts[1] === destination
    )
      return sum + ix.data.readBigUInt64LE(1);
    if (
      ix.data[0] === 12 &&
      ix.data.length === 10 &&
      ix.accounts[0] === source &&
      ix.accounts[1] === NATIVE_MINT.toBase58() &&
      ix.accounts[2] === destination
    )
      return sum + ix.data.readBigUInt64LE(1);
    return sum;
  }, 0n);
}
