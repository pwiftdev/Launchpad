import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

const SESSION_SECONDS = 3600;
const VERSION = 1;
const HEADER_SIZE = 29;
const ALGORITHM = 'aes-256-gcm';

export function privateKey(hex: string | undefined): Buffer | null {
  return hex && /^[0-9a-f]{64}$/.test(hex) ? Buffer.from(hex, 'hex') : null;
}

export function derivePrivateKey(secret: Buffer, scope: string) {
  return Buffer.from(hkdfSync('sha256', secret, '', scope, 32));
}

export function sealPrivate(key: Buffer, context: string, value: string) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, key, nonce, { authTagLength: 16 });
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), nonce, cipher.getAuthTag(), ciphertext]);
}

export function openPrivate(key: Buffer, context: string, packet: Buffer) {
  if (packet.length <= HEADER_SIZE || packet[0] !== VERSION)
    throw new Error('Invalid encrypted envelope');
  const decipher = createDecipheriv(ALGORITHM, key, packet.subarray(1, 13), { authTagLength: 16 });
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(packet.subarray(13, HEADER_SIZE));
  return Buffer.concat([decipher.update(packet.subarray(HEADER_SIZE)), decipher.final()]).toString(
    'utf8'
  );
}

export function privateCookie(name: string, value: string, maxAge = SESSION_SECONDS) {
  return `${name}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}

export function privateSession(
  key: Buffer,
  wallet: string,
  origin: string,
  genesis: string,
  now = Date.now()
) {
  return sealPrivate(
    key,
    JSON.stringify([origin, genesis]),
    JSON.stringify({
      wallet,
      expires: now + SESSION_SECONDS * 1000,
    })
  ).toString('base64url');
}

export function readPrivateSession(
  key: Buffer,
  value: string | undefined,
  origin: string,
  genesis: string,
  now = Date.now()
): string | null {
  if (!value || !/^[A-Za-z0-9_-]{40,256}$/.test(value)) return null;
  try {
    const packet = Buffer.from(value, 'base64url');
    if (packet.toString('base64url') !== value) return null;
    const { wallet, expires } = JSON.parse(
      openPrivate(key, JSON.stringify([origin, genesis]), packet)
    );
    return typeof wallet === 'string' &&
      Number.isSafeInteger(expires) &&
      expires > now &&
      expires <= now + SESSION_SECONDS * 1000
      ? wallet
      : null;
  } catch {
    return null;
  }
}

export function launchPreviewKey(): Buffer | null {
  return process.env.DATABASE_URL ? privateKey(process.env.LAUNCH_PREVIEW_SECRET) : null;
}
