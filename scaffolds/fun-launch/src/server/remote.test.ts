import { afterEach, describe, expect, it, vi } from 'vitest';
import { fetchRemote, readLimited, remoteUrl } from './remote';

afterEach(() => vi.unstubAllGlobals());

describe('untrusted remote files', () => {
  it.each([
    'http://ipfs.io/ipfs/a',
    'https://127.0.0.1/ipfs/a',
    'https://[::1]/ipfs/a',
    'https://169.254.169.254/ipfs/a',
    'https://localhost/ipfs/a',
    'https://ipfs.io.attacker.com/ipfs/a',
    'https://user:pass@ipfs.io/ipfs/a',
    'https://ipfs.io:8443/ipfs/a',
    'https://ipfs.io/api/redirect',
  ])('blocks %s before fetching', async (url) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(fetchRemote(url, 100)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('allows known HTTPS content gateways and disables redirects', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response('image'));
    vi.stubGlobal('fetch', fetch);
    expect(remoteUrl('https://example.mypinata.cloud/ipfs/cid').hostname).toBe(
      'example.mypinata.cloud'
    );
    expect((await fetchRemote('https://ipfs.io/ipfs/cid', 20)).toString()).toBe('image');
    expect(fetch).toHaveBeenCalledWith(
      expect.any(URL),
      expect.objectContaining({ redirect: 'error' })
    );
  });

  it('rejects oversized downloads even without content-length', async () => {
    const response = new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(101));
          controller.close();
        },
      })
    );
    await expect(readLimited(response, 100)).rejects.toThrow('too large');
  });

  it('falls back after a gateway failure without following redirects or changing the CID', async () => {
    const cid = 'bafkreihcfu4dqmbr5iyacioofllgwl2m7sv22bo6woiya6rpiwwcj6ksoi';
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(new Response('rate limited', { status: 429 }))
      .mockResolvedValueOnce(new Response('artwork'));
    vi.stubGlobal('fetch', fetch);
    expect((await fetchRemote(`https://ipfs.io/ipfs/${cid}`, 100)).toString()).toBe('artwork');
    expect(fetch.mock.calls.map(([url]) => url.href)).toEqual([
      `https://gateway.pinata.cloud/ipfs/${cid}`,
      `https://ipfs.io/ipfs/${cid}`,
    ]);
    expect(fetch.mock.calls.every(([, options]) => options.redirect === 'error')).toBe(true);
  });

  it('does not turn an untrusted IPFS-looking URL into an allowed request', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    await expect(
      fetchRemote(
        'https://attacker.example/ipfs/bafkreihcfu4dqmbr5iyacioofllgwl2m7sv22bo6woiya6rpiwwcj6ksoi',
        100
      )
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects oversized declared downloads and error responses', async () => {
    await expect(
      readLimited(new Response('x', { headers: { 'content-length': '200' } }), 100)
    ).rejects.toThrow();
    await expect(readLimited(new Response('error', { status: 500 }), 100)).rejects.toThrow();
  });
});
