import { describe, expect, it } from 'vitest';
import { imageSources, tokenImageSources } from './ipfs';

const cid = 'bafkreihcfu4dqmbr5iyacioofllgwl2m7sv22bo6woiya6rpiwwcj6ksoi';

describe('IPFS artwork sources', () => {
  it('uses same-origin cached artwork first while retaining safe gateway fallbacks', () => {
    const uri = `https://gateway.pinata.cloud/ipfs/${cid}`;
    expect(tokenImageSources(`ipfs://${cid}`)).toEqual([
      `/api/token-image?uri=${encodeURIComponent(uri)}`,
      ...imageSources(uri),
    ]);
    expect(tokenImageSources('/demo/coins/cat.webp')).toEqual(['/demo/coins/cat.webp']);
    expect(tokenImageSources(`https://attacker.example/ipfs/${cid}`)).toEqual([
      `https://attacker.example/ipfs/${cid}`,
    ]);
  });
  it('uses the same content ID across gateways, including native IPFS URIs', () => {
    const expected = [`https://gateway.pinata.cloud/ipfs/${cid}`, `https://ipfs.io/ipfs/${cid}`];
    expect(imageSources(`https://ipfs.io/ipfs/${cid}`)).toEqual(expected);
    expect(imageSources(`ipfs://${cid}`)).toEqual(expected);
    expect(imageSources(`ipfs://ipfs/${cid}`)).toEqual(expected);
  });

  it('keeps dedicated gateways first and preserves content paths', () => {
    const url = `https://project.mypinata.cloud/ipfs/${cid}/logo.png`;
    expect(imageSources(url)).toEqual([
      url,
      `https://gateway.pinata.cloud/ipfs/${cid}/logo.png`,
      `https://ipfs.io/ipfs/${cid}/logo.png`,
    ]);
  });

  it.each([
    '/demo/coins/cat.webp',
    'blob:https://app.example/preview',
    'https://arweave.net/file',
    `https://attacker.example/ipfs/${cid}`,
    `https://user:pass@ipfs.io/ipfs/${cid}`,
    'https://ipfs.io/api/redirect',
  ])('does not rewrite unrelated or unsafe sources: %s', (value) => {
    expect(imageSources(value)).toEqual([value]);
  });
});
