import { afterEach, describe, expect, it, vi } from 'vitest';
import { rpcFetch } from './dbc';

const PRIMARY = 'https://primary.example/rpc',
  FALLBACK = 'https://fallback.example/rpc';
const body = (method: string) => JSON.stringify({ jsonrpc: '2.0', id: 1, method });
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('RPC fallback', () => {
  it('retries a failed or rate-limited read once on the fallback provider', async () => {
    vi.stubEnv('RPC_FALLBACK_URL', FALLBACK);
    for (const failure of [
      () => Promise.resolve(new Response('busy', { status: 429 })),
      () => Promise.resolve(new Response('down', { status: 503 })),
      () => Promise.reject(new TypeError('fetch failed')),
    ]) {
      const fetch = vi
        .fn()
        .mockImplementationOnce(failure)
        .mockResolvedValueOnce(new Response('ok'));
      vi.stubGlobal('fetch', fetch);
      const response = await rpcFetch(PRIMARY, { method: 'POST', body: body('getSlot') });
      expect(await response.text()).toBe('ok');
      expect(fetch.mock.calls.map(([url]) => url)).toEqual([PRIMARY, FALLBACK]);
    }
  });

  it('keeps good and client-error responses, and never resends a transaction', async () => {
    vi.stubEnv('RPC_FALLBACK_URL', FALLBACK);
    const fetch = vi.fn(async (_url: unknown) => new Response('bad request', { status: 400 }));
    vi.stubGlobal('fetch', fetch);
    expect((await rpcFetch(PRIMARY, { body: body('getSlot') })).status).toBe(400);
    fetch.mockImplementation(async (_url: unknown) => new Response('busy', { status: 429 }));
    expect((await rpcFetch(PRIMARY, { body: body('sendTransaction') })).status).toBe(429);
    await expect(
      (fetch.mockRejectedValueOnce(new TypeError('fetch failed')),
      rpcFetch(PRIMARY, { body: body('sendTransaction') }))
    ).rejects.toThrow('fetch failed');
    expect(fetch.mock.calls.every(([url]) => url === PRIMARY)).toBe(true);
  });

  it('uses only the primary provider when no fallback is configured', async () => {
    const fetch = vi.fn(async () => new Response('busy', { status: 429 }));
    vi.stubGlobal('fetch', fetch);
    expect((await rpcFetch(PRIMARY, { body: body('getSlot') })).status).toBe(429);
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
