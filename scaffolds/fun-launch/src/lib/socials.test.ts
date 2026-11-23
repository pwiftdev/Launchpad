import { describe, expect, it } from 'vitest';
import { normalizeSocial, normalizeSocials } from './socials';

describe('project links', () => {
  it('accepts handles and scheme-less links and returns canonical https URLs', () => {
    expect(normalizeSocial('twitter', '@soapyfrog')).toBe('https://x.com/soapyfrog');
    expect(normalizeSocial('twitter', 'twitter.com/soapyfrog/')).toBe('https://x.com/soapyfrog');
    expect(normalizeSocial('twitter', 'https://x.com/i/communities/1234567890')).toBe(
      'https://x.com/i/communities/1234567890'
    );
    expect(normalizeSocial('telegram', '@soapyfrog')).toBe('https://t.me/soapyfrog');
    expect(normalizeSocial('telegram', 't.me/+AbCdEf123')).toBe('https://t.me/+AbCdEf123');
    expect(normalizeSocial('discord', 'https://discord.com/invite/soap')).toBe(
      'https://discord.gg/soap'
    );
    expect(normalizeSocial('website', 'SoapyFrog.xyz/about/')).toBe('https://soapyfrog.xyz/about');
  });

  it('is idempotent on its own output', () => {
    for (const [kind, value] of [
      ['website', 'https://soapyfrog.xyz/a?b=1'],
      ['twitter', 'https://x.com/soapyfrog'],
      ['telegram', 'https://t.me/soapyfrog'],
      ['discord', 'https://discord.gg/soap'],
    ] as const)
      expect(normalizeSocial(kind, normalizeSocial(kind, value))).toBe(value);
  });

  it('rejects links of the wrong kind, unsafe schemes and junk', () => {
    expect(normalizeSocial('twitter', 'https://t.me/soap')).toBeNull();
    expect(normalizeSocial('twitter', 'https://x.com/home')).toBeNull();
    expect(normalizeSocial('twitter', 'https://x.com/a/status/123456')).toBeNull();
    expect(normalizeSocial('telegram', 'https://x.com/soap')).toBeNull();
    expect(normalizeSocial('discord', 'https://discord.com/channels/1/2')).toBeNull();
    expect(normalizeSocial('website', 'javascript:alert(1)')).toBeNull();
    expect(normalizeSocial('website', 'https://user:pw@soap.xyz')).toBeNull();
    expect(normalizeSocial('website', 'http://127.0.0.1:8080')).toBeNull();
    expect(normalizeSocial('website', 'soap')).toBeNull();
    expect(normalizeSocial('website', 'https://soap.xyz/"onmouseover')).toBeNull();
    expect(normalizeSocial('website', 42)).toBeNull();
  });

  it('keeps only valid links in a fixed key order', () => {
    expect(
      Object.keys(
        normalizeSocials({ discord: 'discord.gg/a1', website: 'soap.xyz', twitter: 'nope nope' })
      )
    ).toEqual(['website', 'discord']);
  });
});
