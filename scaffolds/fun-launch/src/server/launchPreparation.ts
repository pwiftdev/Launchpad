import { createHash, createHmac, timingSafeEqual, createPublicKey, verify } from 'node:crypto';
import { PublicKey, Message, type Transaction } from '@solana/web3.js';
import bs58 from 'bs58';
import type { LaunchPreparationContext } from '@/lib/launchPreparation';
type PublicContext = Omit<LaunchPreparationContext, 'preparationProof'> & {
  mint: string;
  wallet: string;
};
const key = () => {
  const secret = process.env.ADMIN_SESSION_SECRET;
  if (!secret || secret.length < 32)
    throw new Error('Launch recovery context signing is unavailable');
  return secret;
};
function body(context: PublicContext) {
  for (const field of ['mint', 'wallet', 'genesis', 'blockhash'] as const)
    if (new PublicKey(context[field]).toBase58() !== context[field])
      throw new Error('Invalid launch recovery identity');
  if (
    !Number.isSafeInteger(context.preparedSlot) ||
    context.preparedSlot < 0 ||
    !Number.isSafeInteger(context.lastValidBlockHeight) ||
    context.lastValidBlockHeight < 0 ||
    !/^[a-f0-9]{64}$/.test(context.messageDigest)
  )
    throw new Error('Invalid launch preparation context');
  return JSON.stringify([
    1,
    context.mint,
    context.wallet,
    context.genesis,
    context.preparedSlot,
    context.lastValidBlockHeight,
    context.blockhash,
    context.messageDigest,
  ]);
}
function mac(context: PublicContext) {
  return createHmac('sha256', key())
    .update('rinsed-launch-preparation-v1\0')
    .update(body(context))
    .digest();
}
/** This public attestation only protects receipt expiry checks; it never authorizes a transfer.
 * Rotating ADMIN_SESSION_SECRET disables old expiry attestations, but original receipts
 * can still be finalized through /api/launch/confirm. No checkpoint secret is used.
 */
export function attestLaunchPreparation(args: {
  transaction: Transaction;
  mint: string;
  wallet: string;
  genesis: string;
  preparedSlot: number;
  lastValidBlockHeight: number;
}): LaunchPreparationContext {
  const { transaction, mint, wallet, genesis, preparedSlot, lastValidBlockHeight } = args;
  if (!transaction.recentBlockhash || transaction.feePayer?.toBase58() !== wallet)
    throw new Error('Prepared launch payer/blockhash mismatch');
  const bytes = transaction.serializeMessage(),
    context = {
      mint,
      wallet,
      genesis,
      preparedSlot,
      lastValidBlockHeight,
      blockhash: transaction.recentBlockhash,
      messageDigest: createHash('sha256').update(bytes).digest('hex'),
      messageBase64: bytes.toString('base64'),
    };
  return {
    genesis,
    preparedSlot,
    lastValidBlockHeight,
    blockhash: context.blockhash,
    messageDigest: context.messageDigest,
    messageBase64: context.messageBase64,
    preparationProof: mac(context).toString('base64url'),
  };
}
export function verifyLaunchPreparation(
  context: PublicContext & { preparationProof: string; signature: string }
) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(context.preparationProof))
    throw new Error('Invalid launch preparation proof');
  const provided = Buffer.from(context.preparationProof, 'base64url'),
    expected = mac(context);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected))
    throw new Error('Launch preparation context could not be authenticated');
  const bytes = Buffer.from(context.messageBase64, 'base64');
  if (
    bytes.length > 1232 ||
    bytes.toString('base64') !== context.messageBase64 ||
    createHash('sha256').update(bytes).digest('hex') !== context.messageDigest
  )
    throw new Error('Launch message differs from its preparation proof');
  const message = Message.from(bytes),
    mintIndex = message.accountKeys.findIndex((key) => key.toBase58() === context.mint);
  if (
    message.accountKeys[0]?.toBase58() !== context.wallet ||
    message.recentBlockhash !== context.blockhash ||
    mintIndex < 1 ||
    mintIndex >= message.header.numRequiredSignatures
  )
    throw new Error('Launch recovery message signer mismatch');
  const wallet = createPublicKey({
    key: Buffer.concat([
      Buffer.from('302a300506032b6570032100', 'hex'),
      new PublicKey(context.wallet).toBuffer(),
    ]),
    format: 'der',
    type: 'spki',
  });
  if (!verify(null, bytes, wallet, bs58.decode(context.signature)))
    throw new Error('Launch signature is not bound to its prepared message');
}
