import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  Connection,
  PublicKey,
  VersionedTransaction,
  type VersionedTransactionResponse,
  type AccountInfo,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { TOKEN_PROGRAM_ID } from '@solana/spl-token';

/** Native PDA initialization accepts harmless pre-funding; a donation is not an initialized receipt. */
export const uninitializedSystemPda = (account: AccountInfo<Buffer> | null) =>
  !account ||
  (account.owner.equals(PublicKey.default) && account.data.length === 0 && !account.executable);

const observed = new WeakSet<object>();
const evidenceRpc = new WeakMap<object, Connection>();
const clocks = new WeakSet<object>();
const failures = new WeakSet<object>();
export type FinalizedFailure = {
  networkGenesis: string;
  signature: string;
  slot: number;
  messageDigest: string;
  feeLamports?: bigint;
};
export function assertFinalizedFailure(value: FinalizedFailure): void {
  if (!failures.has(value)) throw new Error('A finalized failed transaction proof is required');
}
export type FinalizedClock = { networkGenesis: string; slot: number; blockTime: number };
export function assertFinalizedClock(value: FinalizedClock): void {
  if (!clocks.has(value)) throw new Error('An independently verified finalized clock is required');
}
export type FinalizedEvidence = {
  networkGenesis: string;
  signature: string;
  slot: number;
  blockTime: number;
  messageDigest: string;
  transaction: VersionedTransactionResponse;
};
export const messageDigest = (bytes: Uint8Array) =>
  createHash('sha256').update(bytes).digest('hex');
export function assertFinalizedEvidence(value: FinalizedEvidence): void {
  if (!observed.has(value))
    throw new Error('Evidence must be independently read from finalized RPC');
}

/** Network-verified, finalized reads. Never accept a client-provided successful receipt. */
export class FinalizedVerifier {
  constructor(
    private readonly rpc: Connection,
    private readonly genesis: string
  ) {}

  async clock(): Promise<FinalizedClock> {
    if ((await this.rpc.getGenesisHash()) !== this.genesis) throw new Error('RPC network changed');
    const slot = await this.rpc.getSlot('finalized');
    const blockTime = await this.rpc.getBlockTime(slot);
    if (!Number.isSafeInteger(slot) || !Number.isSafeInteger(blockTime) || blockTime! < 0)
      throw new Error('Finalized clock is unavailable');
    const result = { networkGenesis: this.genesis, slot, blockTime: blockTime! };
    clocks.add(result);
    return result;
  }

  async failure(signature: string, expectedMessageDigest: string): Promise<FinalizedFailure> {
    if ((await this.rpc.getGenesisHash()) !== this.genesis) throw new Error('RPC network changed');
    const [statuses, tx] = await Promise.all([
      this.rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }),
      this.rpc.getTransaction(signature, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      }),
    ]);
    const status = statuses.value[0];
    if (
      !status ||
      status.confirmationStatus !== 'finalized' ||
      !status.err ||
      !tx?.meta?.err ||
      !Number.isSafeInteger(tx.meta.fee) ||
      tx.meta.fee < 0 ||
      tx.slot !== status.slot ||
      tx.transaction.signatures[0] !== signature ||
      messageDigest(tx.transaction.message.serialize()) !== expectedMessageDigest
    )
      throw new Error('A failed finalized execution has not been proved');
    const result = {
      networkGenesis: this.genesis,
      signature,
      slot: tx.slot,
      messageDigest: expectedMessageDigest,
      feeLamports: BigInt(tx.meta.fee),
    };
    failures.add(result);
    return result;
  }

  async transaction(signature: string, expectedMessageDigest?: string): Promise<FinalizedEvidence> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature))
      throw new Error('Invalid transaction signature');
    if ((await this.rpc.getGenesisHash()) !== this.genesis) throw new Error('RPC network changed');
    const [statuses, tx] = await Promise.all([
      this.rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }),
      this.rpc.getTransaction(signature, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 0,
      }),
    ]);
    const status = statuses.value[0];
    if (
      !status ||
      status.confirmationStatus !== 'finalized' ||
      status.err ||
      !tx?.meta ||
      tx.meta.err ||
      tx.slot !== status.slot ||
      tx.transaction.signatures[0] !== signature ||
      !Number.isSafeInteger(tx.slot) ||
      !Number.isSafeInteger(tx.blockTime)
    )
      throw new Error('Successful finalized transaction is not available');
    const digest = messageDigest(tx.transaction.message.serialize());
    if (expectedMessageDigest && digest !== expectedMessageDigest)
      throw new Error('Finalized message differs from the prepared transaction');
    const evidence = {
      networkGenesis: this.genesis,
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime!,
      messageDigest: digest,
      transaction: tx,
    };
    observed.add(evidence);
    evidenceRpc.set(evidence, this.rpc);
    clocks.add(evidence);
    return evidence;
  }
}

export async function readEvidenceAccount(evidence: FinalizedEvidence, address: PublicKey) {
  assertFinalizedEvidence(evidence);
  const rpc = evidenceRpc.get(evidence);
  if (!rpc || (await rpc.getGenesisHash()) !== evidence.networkGenesis)
    throw new Error('Finalized evidence RPC is unavailable');
  const result = await rpc.getAccountInfoAndContext(address, {
    commitment: 'finalized',
    minContextSlot: evidence.slot,
  });
  if (result.context.slot < evidence.slot)
    throw new Error('Account evidence predates the finalized transaction');
  return result.value;
}

export function validateSignedTransaction(base64: string, expectedDigest: string) {
  if (base64.length > 1644 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64))
    throw new Error('Invalid signed transaction');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > 1232 || bytes.toString('base64') !== base64)
    throw new Error('Invalid transaction encoding');
  const tx = VersionedTransaction.deserialize(bytes);
  const message = tx.message.serialize();
  if (messageDigest(message) !== expectedDigest)
    throw new Error('Signer changed the prepared message');
  for (let i = 0; i < tx.message.header.numRequiredSignatures; i++) {
    const publicKey = tx.message.staticAccountKeys[i];
    const signature = tx.signatures[i];
    if (
      !publicKey ||
      !signature ||
      signature.length !== 64 ||
      !verify(
        null,
        message,
        createPublicKey({
          key: Buffer.concat([
            Buffer.from('302a300506032b6570032100', 'hex'),
            publicKey.toBuffer(),
          ]),
          format: 'der',
          type: 'spki',
        }),
        signature
      )
    )
      throw new Error('Every required signer must sign the exact prepared message');
  }
  return { signature: bs58.encode(tx.signatures[0]!), bytes };
}

export type ObservedInstruction = {
  instructionIndex: number;
  eventIndex: number;
  program: string;
  accounts: string[];
  data: Buffer;
};

export function allInstructions(evidence: FinalizedEvidence): ObservedInstruction[] {
  assertFinalizedEvidence(evidence);
  const { message } = evidence.transaction.transaction;
  const keys = message.getAccountKeys({
    accountKeysFromLookups: evidence.transaction.meta!.loadedAddresses,
  });
  const result: ObservedInstruction[] = [];
  const add = (
    instructionIndex: number,
    eventIndex: number,
    programIdIndex: number,
    indexes: number[],
    data: Uint8Array
  ) => {
    const program = keys.get(programIdIndex);
    const accounts = indexes.map((index) => keys.get(index)?.toBase58());
    if (!program || accounts.some((account) => !account))
      throw new Error('Unresolved transaction account');
    result.push({
      instructionIndex,
      eventIndex,
      program: program.toBase58(),
      accounts: accounts as string[],
      data: Buffer.from(data),
    });
  };
  message.compiledInstructions.forEach((ix, index) =>
    add(index, 0, ix.programIdIndex, [...ix.accountKeyIndexes], ix.data)
  );
  for (const group of evidence.transaction.meta!.innerInstructions ?? [])
    group.instructions.forEach((ix, index) =>
      add(group.index, index + 1, ix.programIdIndex, [...ix.accounts], bs58.decode(ix.data))
    );
  return result;
}

export function requireInstruction(
  evidence: FinalizedEvidence,
  expected: {
    program: string;
    accounts: string[];
    data: Uint8Array;
    instructionIndex?: number;
  }
): ObservedInstruction {
  const matches = allInstructions(evidence).filter(
    (ix) =>
      ix.program === expected.program &&
      (expected.instructionIndex === undefined ||
        ix.instructionIndex === expected.instructionIndex) &&
      ix.data.equals(Buffer.from(expected.data)) &&
      ix.accounts.length === expected.accounts.length &&
      ix.accounts.every((account, index) => account === expected.accounts[index])
  );
  if (matches.length !== 1) throw new Error('Expected exactly one matching execution instruction');
  return matches[0]!;
}

export function lamportDelta(evidence: FinalizedEvidence, address: string): bigint {
  assertFinalizedEvidence(evidence);
  const tx = evidence.transaction;
  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta!.loadedAddresses,
  });
  let index = -1;
  for (let i = 0; i < keys.length; i++) if (keys.get(i)?.toBase58() === address) index = i;
  if (index < 0) throw new Error('Expected balance account was not part of the transaction');
  const before = tx.meta!.preBalances[index],
    after = tx.meta!.postBalances[index];
  // JSON numeric balances beyond safe integers cannot support exact SOL accounting.
  if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after))
    throw new Error('Unsafe RPC lamport balance');
  return BigInt(after!) - BigInt(before!);
}

export function tokenDelta(evidence: FinalizedEvidence, address: string, mint: string): bigint {
  assertFinalizedEvidence(evidence);
  new PublicKey(mint);
  const tx = evidence.transaction;
  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta!.loadedAddresses,
  });
  const balances = (
    entries: NonNullable<VersionedTransactionResponse['meta']>['preTokenBalances']
  ) => {
    const entry = entries?.find((item) => keys.get(item.accountIndex)?.toBase58() === address);
    if (!entry) return 0n;
    if (entry.mint !== mint || !/^\d+$/.test(entry.uiTokenAmount.amount))
      throw new Error('Unexpected token mint');
    return BigInt(entry.uiTokenAmount.amount);
  };
  return balances(tx.meta!.postTokenBalances) - balances(tx.meta!.preTokenBalances);
}

export function closedNativeAccountRent(
  evidence: FinalizedEvidence,
  address: string,
  owner: string
): bigint {
  assertFinalizedEvidence(evidence);
  const tx = evidence.transaction;
  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta!.loadedAddresses,
  });
  const entry = tx.meta!.preTokenBalances?.find(
    (item) => keys.get(item.accountIndex)?.toBase58() === address
  );
  if (
    !entry ||
    entry.mint !== 'So11111111111111111111111111111111111111112' ||
    entry.owner !== owner ||
    entry.uiTokenAmount.amount !== '0' ||
    tx.meta!.postBalances[entry.accountIndex] !== 0 ||
    tx.meta!.postTokenBalances?.some((item) => item.accountIndex === entry.accountIndex)
  )
    throw new Error('Expected an initialized empty native ATA closed by the funding instruction');
  const rent = tx.meta!.preBalances[entry.accountIndex];
  if (!Number.isSafeInteger(rent) || rent! < 0) throw new Error('Unsafe native ATA balance');
  return BigInt(rent!);
}

export function actualBurnedTokens(
  evidence: FinalizedEvidence,
  account: string,
  mint: string,
  authority: string
): bigint {
  let amount = 0n;
  for (const ix of allInstructions(evidence)) {
    if (ix.program !== TOKEN_PROGRAM_ID.toBase58() || ![8, 15].includes(ix.data[0] ?? -1)) continue;
    if (ix.accounts[0] !== account || ix.accounts[1] !== mint || ix.accounts[2] !== authority)
      continue;
    if (ix.data.length !== (ix.data[0] === 15 ? 10 : 9))
      throw new Error('Unknown burn instruction format');
    amount += ix.data.readBigUInt64LE(1);
  }
  return amount;
}

export function purchasedTokens(
  evidence: FinalizedEvidence,
  source: string,
  destination: string,
  mint: string
): bigint {
  let amount = 0n;
  for (const ix of allInstructions(evidence)) {
    if (ix.program !== TOKEN_PROGRAM_ID.toBase58()) continue;
    if (
      ix.data[0] === 3 &&
      ix.accounts[0] === source &&
      ix.accounts[1] === destination &&
      ix.data.length === 9
    )
      amount += ix.data.readBigUInt64LE(1);
    if (
      ix.data[0] === 12 &&
      ix.accounts[0] === source &&
      ix.accounts[1] === mint &&
      ix.accounts[2] === destination &&
      ix.data.length === 10
    )
      amount += ix.data.readBigUInt64LE(1);
  }
  // Match the declared mint to actual token balance records, including newly created destination ATAs.
  const tx = evidence.transaction;
  const keys = tx.transaction.message.getAccountKeys({
    accountKeysFromLookups: tx.meta!.loadedAddresses,
  });
  for (const address of [source, destination]) {
    const balance = [
      ...(tx.meta!.preTokenBalances ?? []),
      ...(tx.meta!.postTokenBalances ?? []),
    ].find((item) => keys.get(item.accountIndex)?.toBase58() === address);
    if (!balance || balance.mint !== mint)
      throw new Error('Purchase transfer does not belong to the coin mint');
  }
  return amount;
}

/** Refund fees/rent paid by a claiming wallet; the actual program payout remains exact. */
export function netClaimCredit(
  evidence: FinalizedEvidence,
  wallet: string,
  marker?: string
): bigint {
  let credit = lamportDelta(evidence, wallet);
  const tx = evidence.transaction;
  if (tx.transaction.message.staticAccountKeys[0]?.toBase58() === wallet) {
    if (!Number.isSafeInteger(tx.meta!.fee)) throw new Error('Unsafe transaction fee');
    credit += BigInt(tx.meta!.fee);
  }
  for (const ix of allInstructions(evidence)) {
    if (
      ix.program === '11111111111111111111111111111111' &&
      ix.accounts[0] === wallet &&
      marker !== undefined &&
      ix.accounts[1] === marker &&
      ((ix.data.length === 52 && ix.data.readUInt32LE(0) === 0) ||
        (ix.data.length === 12 && ix.data.readUInt32LE(0) === 2))
    )
      credit += ix.data.readBigUInt64LE(4);
  }
  return credit;
}
