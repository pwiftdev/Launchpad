import { describe, expect, it } from 'vitest';
import { assertSocialChallenge, socialMessage, mergeCallouts } from './profiles';
const wallet = 'test-wallet',
  origin = 'https://launch.example';
const now = 1000000,
  expiresAt = new Date(now + 300000).toISOString(),
  nonce = 'a'.repeat(64);
const draft = { username: 'My_Name', bio: ' Hello ', avatarUrl: '' };
const payload = { username: 'my_name', bio: 'Hello', avatarUrl: '' };
const challenge = () => ({
  nonce,
  expiresAt,
  message: socialMessage(origin, wallet, 'profile', payload, nonce, expiresAt),
});
describe('wallet message preview verification', () => {
  it('merges live head and older pages without losing history, duplicates or integer precision', () => {
    const row = (id: string) => ({
      id,
      wallet: 'test',
      body: 'text',
      created_at: '2026-01-01T00:00:00Z',
    });
    const current = [row('9007199254740993'), row('2'), row('1')];
    expect(
      mergeCallouts(current, [row('9007199254740994'), row('9007199254740993')]).map(
        (value) => value.id
      )
    ).toEqual(['9007199254740994', '9007199254740993', '2', '1']);
    expect(mergeCallouts(current, [row('2')])).toHaveLength(3);
  });
  it('accepts only the exact normalized public profile the user entered', () => {
    expect(() =>
      assertSocialChallenge(challenge(), origin, wallet, 'profile', draft, now)
    ).not.toThrow();
    expect(() =>
      assertSocialChallenge(challenge(), origin, 'different-wallet', 'profile', draft, now)
    ).toThrow();
    expect(() =>
      assertSocialChallenge(challenge(), 'https://evil.example', wallet, 'profile', draft, now)
    ).toThrow();
    expect(() =>
      assertSocialChallenge(
        challenge(),
        origin,
        wallet,
        'profile',
        { ...draft, bio: 'Other text' },
        now
      )
    ).toThrow();
  });
  it('rejects arbitrary messages, expired timestamps and content substitution before wallet signing', () => {
    expect(() =>
      assertSocialChallenge(
        { ...challenge(), message: 'Sign a transaction' },
        origin,
        wallet,
        'profile',
        draft,
        now
      )
    ).toThrow();
    expect(() =>
      assertSocialChallenge(challenge(), origin, wallet, 'profile', draft, now + 300001)
    ).toThrow();
    expect(() =>
      assertSocialChallenge({ ...challenge(), nonce: 'x' }, origin, wallet, 'profile', draft, now)
    ).toThrow();
  });
  it('binds callouts to the exact body, mint and server-provided network namespace', () => {
    const content = { networkGenesis: 'a'.repeat(32), mint: 'test-mint', body: 'Plain text' };
    const value = {
      nonce,
      expiresAt,
      message: socialMessage(origin, wallet, 'callout', content, nonce, expiresAt),
    };
    expect(() =>
      assertSocialChallenge(
        value,
        origin,
        wallet,
        'callout',
        { mint: 'test-mint', body: 'Plain text' },
        now
      )
    ).not.toThrow();
    expect(() =>
      assertSocialChallenge(
        value,
        origin,
        wallet,
        'callout',
        { mint: 'other-mint', body: 'Plain text' },
        now
      )
    ).toThrow();
    expect(() =>
      assertSocialChallenge(
        value,
        origin,
        wallet,
        'callout',
        { mint: 'test-mint', body: 'Changed text' },
        now
      )
    ).toThrow();
  });
});
