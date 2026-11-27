import { createPublicKey, verify } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

/** Verifies a wallet's ed25519 signature over a UTF-8 message. Base64 signature, on-curve wallet. */
export function verifyWalletSignature(wallet: string, message: string, signature: string): boolean {
  if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
  try {
    const bytes = Buffer.from(signature, 'base64');
    const address = new PublicKey(wallet);
    if (bytes.length !== 64 || !PublicKey.isOnCurve(address.toBytes())) return false;
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), address.toBuffer()]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(message), key, bytes);
  } catch {
    return false;
  }
}
