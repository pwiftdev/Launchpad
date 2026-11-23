import { createHash } from 'node:crypto';
import { PublicKey, type Connection, type VersionedTransactionResponse } from '@solana/web3.js';
import bs58 from 'bs58';
import {
  FinalizedVerifier,
  allInstructions,
  assertFinalizedEvidence,
  type FinalizedEvidence,
  type ObservedInstruction,
} from './chainEvidence';

type SourceInstruction = Readonly<{
  instructionIndex: number;
  eventIndex: number;
  program: string;
  accounts: readonly string[];
  dataBase64: string;
}>;
/** Finalized RPC observation of external fee sources. This is NOT a signed-message or payout receipt proof. */
export type FinalizedFeeSourceEvidence = Readonly<{
  kind: 'finalized-fee-source';
  networkGenesis: string;
  signature: string;
  slot: number;
  blockTime: number;
  version: 1;
  sourceCommitment: Readonly<{ kind: 'canonical-rpc-fee-source-v1'; digest: string }>;
  instructions: readonly SourceInstruction[];
}>;
export type FeeEvidence = FinalizedEvidence | FinalizedFeeSourceEvidence;
const observedSources = new WeakSet<object>();
export function assertFeeEvidence(value: FeeEvidence): void {
  if (observedSources.has(value)) return;
  assertFinalizedEvidence(value as FinalizedEvidence);
}
export function feeSourceInstructions(value: FeeEvidence): ObservedInstruction[] {
  assertFeeEvidence(value);
  if (!observedSources.has(value)) return allInstructions(value as FinalizedEvidence);
  return (value as FinalizedFeeSourceEvidence).instructions.map((ix) => ({
    instructionIndex: ix.instructionIndex,
    eventIndex: ix.eventIndex,
    program: ix.program,
    accounts: [...ix.accounts],
    data: Buffer.from(ix.dataBase64, 'base64'),
  }));
}
const safe = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
function canonicalInstructions(tx: VersionedTransactionResponse) {
  const message = tx.transaction.message;
  if (tx.version !== 1 || message.version !== 1 || !tx.meta || tx.meta.err)
    throw new Error('Only successful external version-1 sources are supported');
  const keys = message.staticAccountKeys,
    header = message.header;
  if (
    !keys.length ||
    keys.length > 256 ||
    new Set(keys.map((key) => key.toBase58())).size !== keys.length ||
    !safe(header.numRequiredSignatures) ||
    !header.numRequiredSignatures ||
    header.numRequiredSignatures > keys.length ||
    !safe(header.numReadonlySignedAccounts) ||
    header.numReadonlySignedAccounts >= header.numRequiredSignatures ||
    !safe(header.numReadonlyUnsignedAccounts) ||
    header.numReadonlyUnsignedAccounts > keys.length - header.numRequiredSignatures ||
    tx.transaction.signatures.length !== header.numRequiredSignatures ||
    message.compiledInstructions.length > 64 ||
    (tx.meta.loadedAddresses?.readonly.length ?? 0) ||
    (tx.meta.loadedAddresses?.writable.length ?? 0) ||
    message.addressTableLookups.length
  )
    throw new Error('Invalid inline version-1 fee source accounts or roles');
  new PublicKey(message.recentBlockhash);
  for (const signature of tx.transaction.signatures)
    if (bs58.decode(signature).length !== 64 || bs58.encode(bs58.decode(signature)) !== signature)
      throw new Error('Invalid source signature encoding');
  const config = message.transactionConfig;
  const transactionConfig = {
    computeUnitLimit: config.computeUnitLimit,
    heapSize: config.heapSize,
    loadedAccountsDataSizeLimit: config.loadedAccountsDataSizeLimit,
    priorityFee: config.priorityFee,
  };
  for (const value of Object.values(transactionConfig))
    if (value !== null && !safe(value)) throw new Error('Unsafe source transaction configuration');
  const instructions: SourceInstruction[] = [];
  let bytes = 0;
  const add = (
    instructionIndex: number,
    eventIndex: number,
    programIndex: number,
    indexes: readonly number[],
    data: Uint8Array
  ) => {
    if (
      !safe(programIndex) ||
      programIndex >= keys.length ||
      indexes.length > 256 ||
      indexes.some((index) => !safe(index) || index >= keys.length) ||
      data.length > 16384 ||
      instructions.length >= 4096 ||
      (bytes += data.length) > 1048576
    )
      throw new Error('Unresolved or excessive fee source instructions');
    instructions.push(
      Object.freeze({
        instructionIndex,
        eventIndex,
        program: keys[programIndex]!.toBase58(),
        accounts: Object.freeze(indexes.map((index) => keys[index]!.toBase58())),
        dataBase64: Buffer.from(data).toString('base64'),
      })
    );
  };
  message.compiledInstructions.forEach((ix, index) =>
    add(index, 0, ix.programIdIndex, Array.from(ix.accountKeyIndexes), ix.data)
  );
  const groups = tx.meta.innerInstructions ?? [],
    seen = new Set<number>();
  for (const group of groups) {
    if (
      !safe(group.index) ||
      group.index >= message.compiledInstructions.length ||
      seen.has(group.index)
    )
      throw new Error('Invalid fee source inner instruction group');
    seen.add(group.index);
    group.instructions.forEach((ix, index) =>
      add(group.index, index + 1, ix.programIdIndex, Array.from(ix.accounts), bs58.decode(ix.data))
    );
  }
  instructions.sort(
    (a, b) => a.instructionIndex - b.instructionIndex || a.eventIndex - b.eventIndex
  );
  return {
    instructions: Object.freeze(instructions),
    header: {
      numRequiredSignatures: header.numRequiredSignatures,
      numReadonlySignedAccounts: header.numReadonlySignedAccounts,
      numReadonlyUnsignedAccounts: header.numReadonlyUnsignedAccounts,
    },
    accountKeys: keys.map((key) => key.toBase58()),
    recentBlockhash: message.recentBlockhash,
    transactionConfig,
  };
}
/** Reads only external pool observations. Never accepts expectedMessageDigest or creates FinalizedEvidence. */
export class FinalizedFeeSourceReader {
  constructor(
    private rpc: Connection,
    private genesis: string
  ) {}
  async transaction(signature: string): Promise<FinalizedFeeSourceEvidence> {
    if (!/^[1-9A-HJ-NP-Za-km-z]{64,88}$/.test(signature) || bs58.decode(signature).length !== 64)
      throw new Error('Invalid fee source signature');
    if ((await this.rpc.getGenesisHash()) !== this.genesis)
      throw new Error('Fee source RPC network changed');
    const [statuses, tx] = await Promise.all([
      this.rpc.getSignatureStatuses([signature], { searchTransactionHistory: true }),
      this.rpc.getTransaction(signature, {
        commitment: 'finalized',
        maxSupportedTransactionVersion: 1,
      }),
    ]);
    const status = statuses.value[0];
    if (
      !status ||
      status.confirmationStatus !== 'finalized' ||
      status.err ||
      !tx?.meta ||
      tx.meta.err ||
      tx.transaction.signatures[0] !== signature ||
      tx.slot !== status.slot ||
      !safe(tx.slot) ||
      !safe(tx.blockTime) ||
      !safe(statuses.context.slot) ||
      statuses.context.slot < tx.slot
    )
      throw new Error('Successful finalized fee source is unavailable');
    const canonical = canonicalInstructions(tx);
    const body = {
      domain: 'rinsed-finalized-rpc-fee-source-v1',
      networkGenesis: this.genesis,
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime,
      version: 1,
      signatures: [...tx.transaction.signatures],
      ...canonical,
    };
    if ((await this.rpc.getGenesisHash()) !== this.genesis)
      throw new Error('Fee source RPC network changed');
    const evidence: FinalizedFeeSourceEvidence = Object.freeze({
      kind: 'finalized-fee-source',
      networkGenesis: this.genesis,
      signature,
      slot: tx.slot,
      blockTime: tx.blockTime,
      version: 1,
      sourceCommitment: Object.freeze({
        kind: 'canonical-rpc-fee-source-v1',
        digest: createHash('sha256').update(JSON.stringify(body)).digest('hex'),
      }),
      instructions: canonical.instructions,
    });
    observedSources.add(evidence);
    return evidence;
  }
}
/** Preserve historical legacy/v0 proof behavior; fall back only for RPC's explicit unsupported-version error. */
export async function readFinalizedFeeEvidence(
  rpc: Connection,
  genesis: string,
  signature: string
): Promise<FeeEvidence> {
  try {
    return await new FinalizedVerifier(rpc, genesis).transaction(signature);
  } catch (error) {
    if (!error || typeof error !== 'object' || !('code' in error) || error.code !== -32015)
      throw error;
    return new FinalizedFeeSourceReader(rpc, genesis).transaction(signature);
  }
}
