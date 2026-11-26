import { createPublicKey, verify } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

export function verifyWalletMessage(wallet: string, message: string, signature: string): boolean {
  try {
    if (!/^[A-Za-z0-9+/]{86}==$/.test(signature)) return false;
    const key = new PublicKey(wallet);
    if (!PublicKey.isOnCurve(key.toBytes())) return false;
    const publicKey = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), key.toBuffer()]),
      format: 'der',
      type: 'spki',
    });
    return verify(null, Buffer.from(message, 'utf8'), publicKey, Buffer.from(signature, 'base64'));
  } catch {
    return false;
  }
}
