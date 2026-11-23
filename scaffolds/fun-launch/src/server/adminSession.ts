import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { ADMIN_HASH_PATTERN } from '../../../../scripts/admin-key.cjs';
import { siteOrigins } from './siteOrigin';

export const ADMIN_COOKIE = '__Host-rinsed_admin';
export const ADMIN_SESSION_MS = 8 * 60 * 60_000;

function revocationPolicy(): { epoch: string; notBefore: number } | null {
  const epoch = process.env.ADMIN_SESSION_EPOCH ?? '0';
  const raw = process.env.ADMIN_SESSION_NOT_BEFORE_MS ?? '0';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(epoch) || !/^\d{1,16}$/.test(raw)) return null;
  const notBefore = Number(raw);
  return Number.isSafeInteger(notBefore) && notBefore >= 0 ? { epoch, notBefore } : null;
}

export function adminConfigured(): boolean {
  return (
    ADMIN_HASH_PATTERN.test(process.env.ADMIN_KEY_HASH ?? '') &&
    (process.env.ADMIN_SESSION_SECRET?.length ?? 0) >= 32 &&
    revocationPolicy() !== null
  );
}

function mac(body: string): Buffer {
  const secret = process.env.ADMIN_SESSION_SECRET;
  const hash = process.env.ADMIN_KEY_HASH;
  const policy = revocationPolicy();
  if (!secret || !hash || !policy) throw new Error('Admin credentials are unavailable');
  return createHmac('sha256', secret)
    .update('rinsed-admin-v2\0')
    .update(policy.epoch)
    .update('\0')
    .update(hash)
    .update('\0')
    .update(body)
    .digest();
}

export function signAdminSession(now = Date.now(), origin = siteOrigins()[0]): string {
  if (!adminConfigured()) throw new Error('Admin access is not configured');
  const policy = revocationPolicy();
  if (!policy || !Number.isSafeInteger(now) || now < policy.notBefore)
    throw new Error('Admin sessions are revoked until the configured cutoff');
  if (!origin || !siteOrigins().includes(origin)) throw new Error('Unrecognized admin origin');
  const body = Buffer.from(
    JSON.stringify({
      purpose: 'rinsed-admin',
      epoch: policy.epoch,
      origin,
      issued: now,
      expires: now + ADMIN_SESSION_MS,
      nonce: randomBytes(16).toString('hex'),
    })
  ).toString('base64url');
  return `${body}.${mac(body).toString('base64url')}`;
}

export function readAdminSession(value: string | undefined, now = Date.now()): boolean {
  try {
    if (!adminConfigured() || !value || value.length > 700) return false;
    const [body, signature, extra] = value.split('.');
    if (
      !body ||
      !signature ||
      extra ||
      !/^[A-Za-z0-9_-]+$/.test(body) ||
      !/^[A-Za-z0-9_-]{43}$/.test(signature)
    )
      return false;
    const actual = Buffer.from(signature, 'base64url');
    const expected = mac(body);
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return false;
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    const policy = revocationPolicy();
    return (
      policy !== null &&
      payload.purpose === 'rinsed-admin' &&
      payload.epoch === policy.epoch &&
      siteOrigins().includes(payload.origin) &&
      Number.isSafeInteger(payload.issued) &&
      Number.isSafeInteger(payload.expires) &&
      typeof payload.nonce === 'string' &&
      /^[a-f0-9]{32}$/.test(payload.nonce) &&
      payload.issued >= policy.notBefore &&
      payload.issued <= now &&
      payload.expires > now &&
      payload.expires - payload.issued === ADMIN_SESSION_MS
    );
  } catch {
    return false;
  }
}

export function adminCookie(value: string, maxAge = ADMIN_SESSION_MS / 1000): string {
  return `${ADMIN_COOKIE}=${value}; HttpOnly; Secure; SameSite=Strict; Path=/; Max-Age=${maxAge}`;
}
