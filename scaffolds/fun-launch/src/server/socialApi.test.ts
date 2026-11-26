import type { NextApiRequest, NextApiResponse } from 'next';
import { Keypair } from '@solana/web3.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { socialApi } from './socialApi';
const query = vi.hoisted(() => vi.fn());
vi.mock('./database', () => ({ database: () => ({ query }) }));
function response() {
  let status = 200;
  let data: unknown;
  const value = {
    setHeader: vi.fn(),
    status: vi.fn((code: number) => {
      status = code;
      return value;
    }),
    json: vi.fn((body: unknown) => {
      data = body;
      return value;
    }),
  };
  return { res: value as unknown as NextApiResponse, status: () => status, data: () => data };
}
function request(path: string, fields: Partial<NextApiRequest> = {}) {
  return {
    url: path,
    method: 'GET',
    cookies: {},
    query: {},
    headers: { host: 'launch.example' },
    socket: { remoteAddress: '127.0.0.1' },
    ...fields,
  } as NextApiRequest;
}
beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgres://test-only');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'https://launch.example');
  query.mockReset();
  query.mockResolvedValue({ rows: [] });
});
afterEach(() => vi.unstubAllEnvs());
describe('profile and discussion access boundaries', () => {
  it('allows a public profile read while keeping token callouts private while the launchpad is private', async () => {
    const wallet = Keypair.generate().publicKey.toBase58();
    const publicRes = response();
    await socialApi('profile')(
      request('/api/profiles', { query: { wallets: wallet } }),
      publicRes.res
    );
    expect(publicRes.status()).toBe(200);
    const calls = query.mock.calls.length;
    const privateRes = response();
    await socialApi('callout')(
      request('/api/callouts', { query: { mint: wallet } }),
      privateRes.res
    );
    expect(privateRes.status()).toBe(401);
    expect(query).toHaveBeenCalledTimes(calls);
  });
  it('rejects cross-site writes, array inputs, overlarge batches and unsigned update attempts', async () => {
    const cases = [
      request('/api/profiles', {
        method: 'POST',
        headers: { origin: 'https://evil.example', 'content-type': 'application/json' },
        body: {},
      }),
      request('/api/profiles', { query: { wallets: ['x', 'y'] } }),
      request('/api/profiles', { query: { wallets: 'x'.repeat(2251) } }),
      request('/api/profiles', {
        method: 'POST',
        headers: { host: 'launch.example', 'content-type': 'application/json' },
        body: {
          action: 'update',
          wallet: Keypair.generate().publicKey.toBase58(),
          username: 'fake',
        },
      }),
    ];
    for (const req of cases) {
      const result = response();
      await socialApi('profile')(req, result.res);
      expect([400, 403]).toContain(result.status());
    }
    expect(query).not.toHaveBeenCalled();
  });
});
