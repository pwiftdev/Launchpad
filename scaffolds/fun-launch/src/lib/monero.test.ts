import { describe, expect, it } from 'vitest';
import { formatXmr, moneroAddressFrom, moneroAddressKind } from './monero';

// The Monero Project's published general fund donation address.
const GENERAL_FUND =
  '44AFFq5kSiGBoZ4NMDwYtN18obc8AemS33DBLWs3H7otXft3XjrpDtQGv7SqSsaBYBb98uNbr2VBBEt7f2wfn3RVGQBEP3A';
const keys = (fill: number, length = 64) => new Uint8Array(length).fill(fill);

describe('Monero addresses', () => {
  it('accepts a real mainnet address and refuses it on other networks', () => {
    expect(moneroAddressKind(GENERAL_FUND, 'mainnet')).toBe('standard');
    expect(moneroAddressKind(GENERAL_FUND, 'stagenet')).toBeNull();
  });

  it('recognizes subaddresses and integrated addresses by prefix and length', () => {
    expect(moneroAddressKind(moneroAddressFrom(42, keys(7)), 'mainnet')).toBe('subaddress');
    const integrated = moneroAddressFrom(19, keys(9, 72));
    expect(integrated).toHaveLength(106);
    expect(moneroAddressKind(integrated, 'mainnet')).toBe('integrated');
    expect(moneroAddressKind(moneroAddressFrom(24, keys(3)), 'stagenet')).toBe('standard');
  });

  it('refuses a mistyped character, a wrong length and a mismatched key length', () => {
    const typo =
      GENERAL_FUND.slice(0, 50) + (GENERAL_FUND[50] === 'a' ? 'b' : 'a') + GENERAL_FUND.slice(51);
    expect(moneroAddressKind(typo, 'mainnet')).toBeNull();
    expect(moneroAddressKind(GENERAL_FUND.slice(0, 94), 'mainnet')).toBeNull();
    expect(moneroAddressKind('0'.repeat(95), 'mainnet')).toBeNull();
    expect(moneroAddressKind(moneroAddressFrom(19, keys(1)), 'mainnet')).toBeNull();
  });

  it('formats piconero amounts', () => {
    expect(formatXmr(1_500_000_000_000n)).toBe('1.5');
    expect(formatXmr(123_456_789n)).toBe('0.000123');
    expect(formatXmr(0n)).toBe('0');
  });
});
