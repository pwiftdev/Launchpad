import {
  ComputeBudgetProgram,
  PublicKey,
  Transaction,
  type TransactionInstruction,
} from '@solana/web3.js';

/** Independently review the server-built claim before asking a wallet to sign it. */
export function reviewClaimTransaction(
  base64: string,
  expected: TransactionInstruction,
  wallet: PublicKey
): Transaction {
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > 1232 || bytes.toString('base64') !== base64)
    throw new Error('Invalid claim transaction');
  const tx = Transaction.from(bytes);
  if (!tx.feePayer?.equals(wallet)) throw new Error('Unexpected claim fee payer');
  let claims = 0;
  for (const ix of tx.instructions) {
    if (ix.programId.equals(ComputeBudgetProgram.programId)) {
      if (
        ix.keys.length !== 0 ||
        ix.data.length !== 5 ||
        ix.data[0] !== 2 ||
        ix.data.readUInt32LE(1) > 300_000
      )
        throw new Error('Unexpected claim network-fee instruction');
      continue;
    }
    if (
      !ix.programId.equals(expected.programId) ||
      !ix.data.equals(expected.data) ||
      ix.keys.length !== expected.keys.length ||
      !ix.keys.every(
        (key, index) =>
          key.pubkey.equals(expected.keys[index]!.pubkey) &&
          key.isSigner === expected.keys[index]!.isSigner &&
          key.isWritable === expected.keys[index]!.isWritable
      )
    )
      throw new Error('Claim transaction differs from your selected reward');
    claims++;
  }
  if (claims !== 1) throw new Error('Expected exactly one reward claim');
  return tx;
}
