import { generateKeyPairSync, sign } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

export function walletFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    wallet: new PublicKey(
      publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
    ).toBase58(),
    sign: (message: string) => sign(null, Buffer.from(message), privateKey).toString('base64'),
  };
}
