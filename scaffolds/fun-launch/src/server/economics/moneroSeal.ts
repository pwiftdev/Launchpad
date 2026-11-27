// Monero payout addresses are stored encrypted, bound to their claim, and erased once the payout
// settles. The key lives only in the web and operator environments, never in the database.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;

function key(env = process.env): Buffer {
  const hex = env.MONERO_ADDRESS_KEY;
  if (!hex || !/^[0-9a-f]{64}$/.test(hex))
    throw new Error('MONERO_ADDRESS_KEY must be 32 bytes of lowercase hex');
  return Buffer.from(hex, 'hex');
}

export function sealMoneroAddress(claimId: string, address: string, env = process.env): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key(env), iv);
  cipher.setAAD(Buffer.from(`masked-claim:${claimId}`));
  const body = Buffer.concat([cipher.update(address, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), body]);
}

export function openMoneroAddress(claimId: string, sealed: Buffer, env = process.env): string {
  if (sealed[0] !== VERSION || sealed.length < 1 + 12 + 16 + 1)
    throw new Error('Unknown sealed address format');
  const decipher = createDecipheriv('aes-256-gcm', key(env), sealed.subarray(1, 13));
  decipher.setAAD(Buffer.from(`masked-claim:${claimId}`));
  decipher.setAuthTag(sealed.subarray(13, 29));
  return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]).toString('utf8');
}

export const moneroSealConfigured = (env = process.env) =>
  !!env.MONERO_ADDRESS_KEY && /^[0-9a-f]{64}$/.test(env.MONERO_ADDRESS_KEY);
