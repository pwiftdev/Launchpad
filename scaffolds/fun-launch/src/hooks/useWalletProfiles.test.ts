import { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadWalletProfiles } from './useWalletProfiles';
import type { WalletProfile } from '@/lib/profiles';
const profile = (wallet: string): WalletProfile => ({
  wallet,
  username: 'tester',
  bio: '',
  avatar_url: '',
  updated_at: '2026-01-01T00:00:00Z',
});
afterEach(() => vi.unstubAllGlobals());
describe('batched profile identity cache', () => {
  it('uses one request for 50 wallets and fetches only new identities on list expansion', async () => {
    const client = new QueryClient();
    const wallets = Array.from({ length: 50 }, (_, i) => `wallet-${i}`);
    const fetcher = vi.fn(async (url: string) => {
      const requested = new URL(url, 'https://example.test').searchParams
        .get('wallets')!
        .split(',');
      return Response.json({ profiles: requested.map(profile) });
    });
    vi.stubGlobal('fetch', fetcher);
    expect(
      Object.keys(
        (await loadWalletProfiles(client, wallets, new AbortController().signal)).profiles
      )
    ).toHaveLength(50);
    expect(fetcher).toHaveBeenCalledTimes(1);
    const expanded = await loadWalletProfiles(
      client,
      [...wallets, 'new-wallet'],
      new AbortController().signal
    );
    expect(Object.keys(expanded.profiles)).toHaveLength(51);
    expect(fetcher.mock.calls[1]?.[0]).toBe('/api/profiles?wallets=new-wallet');
    await loadWalletProfiles(client, wallets, new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('retains cached names and successful batches when another batch fails', async () => {
    const client = new QueryClient();
    client.setQueryData(['wallet-profile', 'old'], profile('old'));
    const wallets = ['old', ...Array.from({ length: 51 }, (_, i) => `wallet-${i}`)];
    const fetcher = vi.fn(async (url: string) => {
      const requested = new URL(url, 'https://example.test').searchParams
        .get('wallets')!
        .split(',');
      if (requested.includes('wallet-50')) throw new Error('Timeout');
      return Response.json({ profiles: requested.map(profile) });
    });
    vi.stubGlobal('fetch', fetcher);
    const result = await loadWalletProfiles(client, wallets, new AbortController().signal);
    expect(result.partialFailure).toBe(true);
    expect(result.profiles.old?.username).toBe('tester');
    expect(Object.keys(result.profiles)).toHaveLength(51);
    expect(client.getQueryData(['wallet-profile', 'wallet-50'])).toBeUndefined();
  });
  it('caches missing usernames and refreshes them after explicit invalidation', async () => {
    const client = new QueryClient();
    const fetcher = vi.fn(async () => Response.json({ profiles: [] }));
    vi.stubGlobal('fetch', fetcher);
    await loadWalletProfiles(client, ['new-wallet'], new AbortController().signal);
    await loadWalletProfiles(client, ['new-wallet'], new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(1);
    await client.invalidateQueries({ queryKey: ['wallet-profile'] });
    await loadWalletProfiles(client, ['new-wallet'], new AbortController().signal);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
