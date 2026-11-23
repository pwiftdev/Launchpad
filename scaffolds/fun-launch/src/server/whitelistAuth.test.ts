import { generateKeyPairSync, sign } from 'node:crypto';
import { PublicKey } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { whitelistMessage } from '@/lib/whitelist';
import {
  readWhitelistSession,
  signWhitelistSession,
  verifyWalletMessage,
  whitelistBucket,
} from './whitelistAuth';

beforeEach(() =>
  vi.stubEnv('WHITELIST_SECRET', 'test-only-secret-that-is-more-than-32-characters')
);
afterEach(() => vi.unstubAllEnvs());

describe('early-access wallet verification', () => {
  it('binds proof to the domain, wallet, nonce, interest and expiry', () => {
    const keys = generateKeyPairSync('ed25519');
    const wallet = new PublicKey(
      keys.publicKey.export({ format: 'der', type: 'spki' }).subarray(-32)
    ).toBase58();
    const fields = {
      origin: 'https://launch.example',
      wallet,
      nonce: 'a'.repeat(64),
      interest: 'both' as const,
      issuedAt: '2026-10-27T10:00:00Z',
      expiresAt: '2026-10-27T10:05:00Z',
    };
    const message = whitelistMessage(fields);
    const signature = sign(null, Buffer.from(message), keys.privateKey).toString('base64');
    expect(verifyWalletMessage(wallet, message, signature)).toBe(true);
    for (const change of [
      { origin: 'https://attacker.example' },
      { nonce: 'b'.repeat(64) },
      { interest: 'creator' as const },
      { referralCode: 'SOAPY42X' },
      { expiresAt: '2027-01-01T00:00:00Z' },
    ])
      expect(
        verifyWalletMessage(wallet, whitelistMessage({ ...fields, ...change }), signature)
      ).toBe(false);
    expect(verifyWalletMessage(PublicKey.default.toBase58(), message, signature)).toBe(false);
    expect(verifyWalletMessage(wallet, message, 'invalid')).toBe(false);
    expect(message).toContain('No transaction, payment, token approval, or spending permission');
  });

  it('rejects altered, expired or malformed registration cookies', () => {
    const token = signWhitelistSession('wallet', 'registration', 1000);
    expect(readWhitelistSession(token, 1001)).toEqual({
      wallet: 'wallet',
      registrationId: 'registration',
    });
    expect(readWhitelistSession(token, 1000 + 30 * 86400_000)).toBeNull();
    expect(readWhitelistSession('A' + token.slice(1), 1001)).toBeNull();
    expect(readWhitelistSession(token + '.extra', 1001)).toBeNull();
    expect(readWhitelistSession(undefined)).toBeNull();
    vi.stubEnv('WHITELIST_SECRET', 'a-different-secret-that-is-more-than-32-chars');
    expect(readWhitelistSession(token, 1001)).toBeNull();
  });

  it('hashes rate-limit identities with a server-held key', () => {
    const value = whitelistBucket('challenge-ip:192.0.2.1');
    expect(value).toMatch(/^[a-f0-9]{64}$/);
    expect(value).not.toContain('192.0.2.1');
    expect(whitelistBucket('challenge-ip:192.0.2.2')).not.toBe(value);
    vi.stubEnv('WHITELIST_SECRET', '');
    expect(() => signWhitelistSession('wallet', 'registration')).toThrow();
  });
});
