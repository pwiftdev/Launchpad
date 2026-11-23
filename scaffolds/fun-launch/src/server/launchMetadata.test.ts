import { describe, expect, it } from 'vitest';
import { buildLaunchMetadata } from './launchMetadata';
import { sanitizeMetadata } from './offchainMetadataValue';

const base = {
  tokenName: 'Soapy Frog',
  tokenSymbol: 'SOAP',
  mint: 'So11111111111111111111111111111111111111112',
  image:
    'https://gateway.pinata.cloud/ipfs/bafkreihcfu4dqmbr5iyacioofllgwl2m7sv22bo6woiya6rpiwwcj6ksoi',
  burnShare: 0,
  mode: 'community' as const,
};

describe('launch metadata JSON', () => {
  it('writes project links top-level and under extensions, in canonical form', () => {
    const json = buildLaunchMetadata({
      ...base,
      socials: { twitter: '@soapyfrog', website: 'soapyfrog.xyz', discord: 'discord.gg/soap' },
    });
    expect(json).toMatchObject({
      website: 'https://soapyfrog.xyz',
      twitter: 'https://x.com/soapyfrog',
      discord: 'https://discord.gg/soap',
      extensions: {
        website: 'https://soapyfrog.xyz',
        twitter: 'https://x.com/soapyfrog',
        discord: 'https://discord.gg/soap',
      },
      launchMode: 'community',
    });
    expect(json.telegram).toBeUndefined();
  });

  it('round-trips through the metadata reader the board and token page use', () => {
    const json = buildLaunchMetadata({ ...base, socials: { telegram: 't.me/soapyfrog' } });
    expect(sanitizeMetadata(JSON.parse(JSON.stringify(json)))).toMatchObject({
      telegram: 'https://t.me/soapyfrog',
    });
  });

  it('leaves link fields out entirely when none were given', () => {
    const json = buildLaunchMetadata({ ...base, socials: {} });
    expect(Object.keys(json)).not.toContain('extensions');
    expect(Object.keys(json)).not.toContain('website');
  });
});
