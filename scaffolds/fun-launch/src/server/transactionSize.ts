import type { Transaction } from '@solana/web3.js';

export class TransactionSizeError extends Error {}

/** Includes every reserved signature, even before the wallet/mint have signed. */
export function assertLegacyPacketFits(transaction: Transaction): number {
  const message = transaction.compileMessage();
  const size = 1 + message.header.numRequiredSignatures * 64 + message.serialize().length;
  if (size > 1232)
    throw new TransactionSizeError(
      'Launch transaction is too large. Shorten the token name or use a shorter metadata gateway URL.'
    );
  return size;
}
