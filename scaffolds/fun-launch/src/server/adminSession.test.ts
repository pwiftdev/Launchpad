import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { hashAdminKey, verifyAdminKey } from '../../../../scripts/admin-key.cjs';
import {
  adminConfigured,
  readAdminSession,
  signAdminSession,
  ADMIN_SESSION_MS,
} from './adminSession';

const hash = `pbkdf2-sha256$600000$${'a'.repeat(32)}$${'b'.repeat(64)}`;
beforeEach(() => {
  vi.stubEnv('ADMIN_KEY_HASH', hash);
  vi.stubEnv('ADMIN_SESSION_SECRET', 'test-session-secret-that-is-over-32-characters');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://launch.example');
});
afterEach(() => vi.unstubAllEnvs());

describe('private launchpad access', () => {
  it('revokes every old session by changing the epoch while preserving credentials', () => {
    const token = signAdminSession(1000);
    expect(readAdminSession(token, 1001)).toBe(true);
    vi.stubEnv('ADMIN_SESSION_EPOCH', 'incident-rotation-2026');
    expect(readAdminSession(token, 1001)).toBe(false);
    const fresh = signAdminSession(1002);
    expect(readAdminSession(fresh, 1003)).toBe(true);
    expect(process.env.ADMIN_KEY_HASH).toBe(hash);
  });
  it('applies the not-before cutoff and fails closed for malformed revocation settings', () => {
    const old = signAdminSession(1000);
    vi.stubEnv('ADMIN_SESSION_NOT_BEFORE_MS', '1001');
    expect(readAdminSession(old, 1002)).toBe(false);
    expect(() => signAdminSession(1000)).toThrow('revoked');
    expect(readAdminSession(signAdminSession(1001), 1002)).toBe(true);
    for (const invalid of ['NaN', '-1', '9007199254740992']) {
      vi.stubEnv('ADMIN_SESSION_NOT_BEFORE_MS', invalid);
      expect(adminConfigured()).toBe(false);
      expect(readAdminSession(old, 1002)).toBe(false);
    }
    vi.stubEnv('ADMIN_SESSION_NOT_BEFORE_MS', '0');
    vi.stubEnv('ADMIN_SESSION_EPOCH', '<script>');
    expect(adminConfigured()).toBe(false);
  });
  it('keeps the launchpad closed when either credential is absent or malformed', () => {
    vi.stubEnv('ADMIN_KEY_HASH', '');
    expect(adminConfigured()).toBe(false);
    expect(readAdminSession('anything')).toBe(false);
    expect(() => signAdminSession()).toThrow();
    vi.stubEnv('ADMIN_KEY_HASH', 'plaintext');
    expect(adminConfigured()).toBe(false);
    vi.stubEnv('ADMIN_KEY_HASH', hash);
    vi.stubEnv('ADMIN_SESSION_SECRET', 'short');
    expect(adminConfigured()).toBe(false);
  });
  it('rejects tampering, expiry and cookies from other origins or credential versions', () => {
    const token = signAdminSession(1000);
    expect(readAdminSession(token, 1001)).toBe(true);
    expect(readAdminSession(token, 999)).toBe(false);
    expect(readAdminSession(token, 1000 + ADMIN_SESSION_MS)).toBe(false);
    expect(readAdminSession('A' + token.slice(1), 1001)).toBe(false);
    expect(readAdminSession(token + '.extra', 1001)).toBe(false);
    expect(readAdminSession(undefined, 1001)).toBe(false);
    expect(readAdminSession('bad.whitelist-cookie', 1001)).toBe(false);
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://other.example');
    expect(readAdminSession(token, 1001)).toBe(false);
    vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://launch.example');
    vi.stubEnv('ADMIN_KEY_HASH', hash.replace('bbbb', 'cccc'));
    expect(readAdminSession(token, 1001)).toBe(false);
    vi.stubEnv('ADMIN_KEY_HASH', hash);
    vi.stubEnv('ADMIN_SESSION_SECRET', 'rotated-session-secret-that-is-over-32-characters');
    expect(readAdminSession(token, 1001)).toBe(false);
  });
  it('salts keys, accepts the chosen key and rejects wrong or malformed credentials', async () => {
    const key = 'test-only-password-manager-generated-key';
    const first = await hashAdminKey(key);
    const second = await hashAdminKey(key);
    expect(first).not.toBe(second);
    expect(first).not.toContain(key);
    expect(await verifyAdminKey(key, first)).toBe(true);
    expect(await verifyAdminKey('wrong-password-manager-generated-key', first)).toBe(false);
    expect(await verifyAdminKey(key, 'malformed')).toBe(false);
    await expect(hashAdminKey('short')).rejects.toThrow();
  });
});
