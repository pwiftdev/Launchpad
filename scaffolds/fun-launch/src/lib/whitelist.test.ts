import { describe, expect, it } from 'vitest';
import { REFERRAL_ALPHABET, parseReferralCode, whitelistMessage } from './whitelist';
import { generateReferralCode } from '@/server/whitelistStore';

const fields = {
  origin: 'https://rinsed.fun',
  wallet: 'Wallet1111111111111111111111111111111111111',
  interest: 'both' as const,
  nonce: 'a'.repeat(64),
  issuedAt: '2026-10-27T10:00:00Z',
  expiresAt: '2026-10-27T10:05:00Z',
};

describe('referral codes', () => {
  it('parses codes from links, case-insensitively', () => {
    expect(parseReferralCode('soapy42x')).toBe('SOAPY42X');
    expect(parseReferralCode(' 8C1A2E9F ')).toBe('8C1A2E9F');
  });

  it('rejects anything that is not an 8-character code', () => {
    for (const bad of ['', 'SHORT', 'TOOLONGCODE1', 'BAD-CODE', undefined, 42, ['SOAPY42X']])
      expect(parseReferralCode(bad)).toBeNull();
  });

  it('generates unambiguous 8-character codes', () => {
    const codes = new Set(Array.from({ length: 500 }, generateReferralCode));
    expect(codes.size).toBe(500);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z0-9]{8}$/);
      for (const ch of code) expect(REFERRAL_ALPHABET).toContain(ch);
      expect(code).not.toMatch(/[01OIL]/);
    }
  });
});

describe('whitelistMessage', () => {
  it('names the referral code in what the wallet signs', () => {
    expect(whitelistMessage({ ...fields, referralCode: 'SOAPY42X' })).toContain(
      'Interest: both\nReferred by code: SOAPY42X\n'
    );
  });

  it('is unchanged when there is no referral', () => {
    const message = whitelistMessage(fields);
    expect(message).not.toContain('Referred by');
    expect(message).toBe(whitelistMessage({ ...fields, referralCode: null }));
    // The page checks these lines before asking the wallet to sign
    expect(message).toContain(`Website: ${fields.origin}\nWallet: ${fields.wallet}\n`);
  });
});
