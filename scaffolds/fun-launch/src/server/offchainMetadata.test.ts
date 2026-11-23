import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OffchainMetadataCache } from './offchainMetadata';
import { fetchRemote } from './remote';

vi.mock('./remote', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./remote')>()),
  fetchRemote: vi.fn(),
}));

const fetch = vi.mocked(fetchRemote);
const cid = 'bafkreihcfu4dqmbr5iyacioofllgwl2m7sv22bo6woiya6rpiwwcj6ksoi';
const uri = `https://ipfs.io/ipfs/${cid}`;
const body = (value: unknown) => Buffer.from(JSON.stringify(value));

beforeEach(() => {
  vi.useFakeTimers();
  fetch.mockReset();
});
afterEach(() => vi.useRealTimers());

describe('off-chain metadata recovery', () => {
  it('serves newly uploaded metadata immediately without refetching it from a gateway', async () => {
    const cache = new OffchainMetadataCache();
    await cache.seed(uri, { image: uri, description: 'Fresh launch' });
    expect(await cache.get(uri)).toMatchObject({
      image: uri.replace('ipfs.io', 'gateway.pinata.cloud'),
      description: 'Fresh launch',
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('keeps bounded plain text descriptions while discarding oversized display copy', async () => {
    fetch.mockResolvedValueOnce(
      body({ image: uri, description: ' A coin story\u0000\nfor holders. ' })
    );
    const cache = new OffchainMetadataCache();
    expect((await cache.get(uri)).description).toBe('A coin story\nfor holders.');
    fetch.mockResolvedValueOnce(body({ image: uri, description: '😀'.repeat(1001) }));
    expect((await cache.get(`${uri}/other`)).description).toBeUndefined();
  });
  it('reads project links from top-level fields or the extensions convention', async () => {
    fetch.mockResolvedValueOnce(
      body({
        image: uri,
        twitter: '@soapyfrog',
        website: 'javascript:alert(1)',
        extensions: { website: 'soapyfrog.xyz', telegram: 'https://x.com/nope' },
      })
    );
    const value = await new OffchainMetadataCache().get(uri);
    expect(value).toMatchObject({
      twitter: 'https://x.com/soapyfrog',
      website: 'https://soapyfrog.xyz',
    });
    expect(value.telegram).toBeUndefined();
  });
  it('rejects executable source links and oversized image URLs from untrusted metadata', async () => {
    fetch.mockResolvedValue(
      body({ image: `${uri}/${'x'.repeat(3000)}`, source: 'javascript:alert(1)' })
    );
    expect(await new OffchainMetadataCache().get(uri)).toEqual({ image: null, source: null });
  });
  it('retries transient failures after a cooldown and retains recovered artwork', async () => {
    const cache = new OffchainMetadataCache();
    fetch
      .mockRejectedValueOnce(new Error('429'))
      .mockResolvedValue(body({ image: uri, source: 'https://x.com/creator/status/12345' }));
    expect(await cache.get(uri)).toEqual({ image: null, source: null });
    expect(await cache.get(uri)).toEqual({ image: null, source: null });
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(30_001);
    const recovered = await cache.get(uri);
    expect(recovered.image).toBe(`https://gateway.pinata.cloud/ipfs/${cid}`);
    expect(recovered.source).toBe('https://x.com/creator/status/12345');
    await vi.advanceTimersByTimeAsync(3_600_000);
    expect(await cache.get(uri)).toEqual(recovered);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('shares a single in-flight download between board and token requests', async () => {
    const cache = new OffchainMetadataCache();
    let finish!: (value: Buffer) => void;
    fetch.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      })
    );
    const pending = Promise.all([cache.get(uri), cache.get(uri), cache.get(uri)]);
    expect(fetch).toHaveBeenCalledTimes(1);
    finish(body({ image: `ipfs://${cid}` }));
    const results = await pending;
    expect(
      results.every((result) => result.image === `https://gateway.pinata.cloud/ipfs/${cid}`)
    ).toBe(true);
  });

  it('retries malformed responses rather than retaining a permanent empty image', async () => {
    const cache = new OffchainMetadataCache();
    fetch
      .mockResolvedValueOnce(Buffer.from('<html>Gateway error</html>'))
      .mockResolvedValue(body({ image: uri }));
    expect((await cache.get(uri)).image).toBeNull();
    await vi.advanceTimersByTimeAsync(30_001);
    expect((await cache.get(uri)).image).not.toBeNull();
  });

  it('ignores unsafe image URLs while retaining valid source metadata', async () => {
    const cache = new OffchainMetadataCache();
    fetch.mockResolvedValue(
      body({ image: 'https://127.0.0.1/private.png', source: 'https://x.com/creator/status/12345' })
    );
    expect(await cache.get(uri)).toEqual({
      image: null,
      source: 'https://x.com/creator/status/12345',
    });
  });
  it('bounds local entries and queued downloads instead of fetching every untrusted URI at once', async () => {
    const small = new OffchainMetadataCache({ maxEntries: 2 });
    fetch.mockResolvedValue(body({ image: uri }));
    await small.get(uri);
    await small.get(`${uri}/two`);
    await small.get(`${uri}/three`);
    await small.get(uri);
    expect(fetch).toHaveBeenCalledTimes(4);
    fetch.mockClear();
    let active = 0,
      maximum = 0;
    fetch.mockImplementation(async () => {
      active++;
      maximum = Math.max(maximum, active);
      await Promise.resolve();
      active--;
      return body({ image: uri });
    });
    const bounded = new OffchainMetadataCache();
    await Promise.all(Array.from({ length: 100 }, (_, index) => bounded.get(`${uri}/${index}`)));
    expect(maximum).toBeLessThanOrEqual(6);
    expect(fetch).toHaveBeenCalledTimes(70);
  });
});
