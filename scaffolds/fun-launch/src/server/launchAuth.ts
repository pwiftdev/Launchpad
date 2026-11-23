import { createPublicKey, verify } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { launchMessage, type LaunchPayload } from '@/lib/launchAuth';
import { takeLimit } from './apiGuard';

export async function verifyLaunch(
  payload: LaunchPayload,
  origin: string,
  issuedAt: unknown,
  signature: unknown
): Promise<boolean> {
  if (
    typeof issuedAt !== 'number' ||
    !Number.isSafeInteger(issuedAt) ||
    Math.abs(Date.now() - issuedAt) > 5 * 60_000
  )
    return false;
  if (typeof signature !== 'string' || !/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
  try {
    const key = createPublicKey({
      key: Buffer.concat([
        Buffer.from('302a300506032b6570032100', 'hex'),
        new PublicKey(payload.userWallet).toBuffer(),
      ]),
      format: 'der',
      type: 'spki',
    });
    const message = await launchMessage(payload, origin, issuedAt);
    if (!verify(null, Buffer.from(message), key, Buffer.from(signature, 'base64'))) return false;
    // A valid signed request is consumed before uploads begin, including failed attempts.
    return takeLimit(`launch-signature:${signature}`, 1, 10 * 60_000);
  } catch {
    return false;
  }
}
