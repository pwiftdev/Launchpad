// Test-only RPC fixtures. No network connections and no persisted wallet keys.
import {
  Keypair,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  type Connection,
  type VersionedTransactionResponse,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { FinalizedVerifier, type FinalizedEvidence } from './chainEvidence';

export const fixtureGenesis = 'isolated-financial-tests';
export const fixtureWallet = () => Keypair.generate();
export function unsignedTransaction(tx: Transaction): string {
  const copy = VersionedTransaction.deserialize(tx.serialize());
  copy.signatures = copy.signatures.map(() => new Uint8Array(64));
  return Buffer.from(copy.serialize()).toString('base64');
}
export function transactionFixture(
  instructions: TransactionInstruction[],
  payer = fixtureWallet(),
  slot = 1000,
  blockTime = 3600
) {
  const tx = new Transaction({
    feePayer: payer.publicKey,
    recentBlockhash: fixtureWallet().publicKey.toBase58(),
  }).add(...instructions);
  tx.sign(payer);
  const message = tx.compileMessage(),
    signature = bs58.encode(tx.signatures[0]!.signature!);
  const accounts = message.accountKeys;
  const meta: NonNullable<VersionedTransactionResponse['meta']> = {
    err: null,
    fee: 5000,
    preBalances: accounts.map(() => 10_000_000),
    postBalances: accounts.map(() => 10_000_000),
    preTokenBalances: [],
    postTokenBalances: [],
    innerInstructions: [],
    logMessages: [],
  };
  const response = {
    slot,
    blockTime,
    version: 'legacy',
    meta,
    transaction: { message, signatures: [signature] },
  } as unknown as VersionedTransactionResponse;
  const rpc = {
    getGenesisHash: async () => fixtureGenesis,
    getSignatureStatuses: async () => ({
      context: { slot },
      value: [
        {
          slot,
          err: meta.err,
          confirmationStatus: 'finalized' as const,
          confirmations: null as number | null,
        },
      ],
    }),
    getTransaction: async () => response,
    getSlot: async () => slot,
    getBlockTime: async () => blockTime,
  } as unknown as Connection;
  return {
    tx,
    rpc,
    response,
    signature,
    payer,
    accounts,
    evidence: (): Promise<FinalizedEvidence> =>
      new FinalizedVerifier(rpc, fixtureGenesis).transaction(signature),
    balance: (address: string, before: number, after: number) => {
      const index = accounts.findIndex((key) => key.toBase58() === address);
      if (index < 0) throw new Error('Fixture account missing');
      meta.preBalances[index] = before;
      meta.postBalances[index] = after;
      return index;
    },
  };
}
