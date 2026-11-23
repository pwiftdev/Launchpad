import { createHmac, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';

export function whitelistSecret(): string {
  const secret = process.env.WHITELIST_SECRET;
  if (!secret || secret.length < 32) throw new Error('Whitelist authentication is not configured');
  return secret;
}

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

export function signWhitelistSession(
  wallet: string,
  registrationId: string,
  now = Date.now()
): string {
  const body = Buffer.from(
    JSON.stringify({ wallet, registrationId, expires: now + 30 * 86400_000 })
  ).toString('base64url');
  return `${body}.${createHmac('sha256', whitelistSecret()).update(body).digest('base64url')}`;
}

export function readWhitelistSession(
  value: string | undefined,
  now = Date.now()
): { wallet: string; registrationId: string } | null {
  try {
    if (!value || value.length > 600) return null;
    const [body, mac, extra] = value.split('.');
    if (extra || !body || !mac) return null;
    const expected = createHmac('sha256', whitelistSecret()).update(body).digest();
    const actual = Buffer.from(mac, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return null;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    if (
      typeof payload.wallet !== 'string' ||
      typeof payload.registrationId !== 'string' ||
      !Number.isSafeInteger(payload.expires) ||
      payload.expires <= now ||
      payload.expires > now + 31 * 86400_000
    )
      return null;
    return { wallet: payload.wallet, registrationId: payload.registrationId };
  } catch {
    return null;
  }
}

export function whitelistBucket(value: string): string {
  return createHmac('sha256', whitelistSecret()).update(value).digest('hex');
}
