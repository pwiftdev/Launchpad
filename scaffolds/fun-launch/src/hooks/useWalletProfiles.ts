import { useCallback, useEffect } from 'react';
import { useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';
import type { WalletProfile } from '@/lib/profiles';

const PROFILE_FRESH_MS = 60_000;
const profileKey = (wallet: string) => ['wallet-profile', wallet] as const;
type ProfilesResult = { profiles: Record<string, WalletProfile>; partialFailure: boolean };
export function refreshWalletProfiles() {
  window.dispatchEvent(new Event('rinsed:profiles'));
}

/** Batch only missing/stale identities; keep successful batches if another times out. */
export async function loadWalletProfiles(
  client: QueryClient,
  wallets: string[],
  signal: AbortSignal
): Promise<ProfilesResult> {
  const profiles: Record<string, WalletProfile> = {};
  const missing = wallets.filter((wallet) => {
    const cached = client.getQueryData<WalletProfile | null>(profileKey(wallet));
    if (cached) profiles[wallet] = cached;
    const state = client.getQueryState(profileKey(wallet));
    return (
      cached === undefined ||
      state?.isInvalidated ||
      Date.now() - (state?.dataUpdatedAt ?? 0) >= PROFILE_FRESH_MS
    );
  });
  const batches = Array.from({ length: Math.ceil(missing.length / 50) }, (_, i) =>
    missing.slice(i * 50, i * 50 + 50)
  );
  const results = await Promise.allSettled(
    batches.map(async (batch) => {
      const response = await fetch(`/api/profiles?wallets=${encodeURIComponent(batch.join(','))}`, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]),
      });
      if (!response.ok) throw new Error('Profiles are temporarily unavailable.');
      const result = (await response.json()) as { profiles: WalletProfile[] };
      const returned = new Map(
        result.profiles
          .filter((profile) => batch.includes(profile.wallet))
          .map((profile) => [profile.wallet, profile])
      );
      for (const wallet of batch) {
        const profile = returned.get(wallet) ?? null;
        client.setQueryData(profileKey(wallet), profile);
        if (profile) profiles[wallet] = profile;
        else delete profiles[wallet];
      }
    })
  );
  if (results.length && results.every((result) => result.status === 'rejected'))
    throw new Error('Profiles are temporarily unavailable.');
  return { profiles, partialFailure: results.some((result) => result.status === 'rejected') };
}

export function useWalletProfiles(wallets: string[]) {
  const client = useQueryClient();
  const key = [...new Set(wallets.filter(Boolean))].sort().slice(0, 500).join(',');
  const selected = key ? key.split(',') : [];
  const query = useQuery<ProfilesResult>({
    queryKey: ['wallet-profiles', key],
    queryFn: ({ signal }) =>
      loadWalletProfiles(client, selected, signal ?? new AbortController().signal),
    enabled: !!key,
    staleTime: PROFILE_FRESH_MS,
    retry: 1,
  });
  const refresh = useCallback(() => {
    void client.invalidateQueries({ queryKey: ['wallet-profile'] });
    void client.invalidateQueries({ queryKey: ['wallet-profiles'] });
  }, [client]);
  useEffect(() => {
    window.addEventListener('rinsed:profiles', refresh);
    return () => window.removeEventListener('rinsed:profiles', refresh);
  }, [refresh]);
  const profiles: Record<string, WalletProfile> = {};
  for (const wallet of selected) {
    const cached = client.getQueryData<WalletProfile | null>(profileKey(wallet));
    const profile = cached === undefined ? query.data?.profiles[wallet] : cached;
    if (profile) profiles[wallet] = profile;
  }
  return {
    profiles,
    loading: !!key && query.isLoading,
    error:
      query.error || query.data?.partialFailure ? 'Profiles are temporarily unavailable.' : null,
    refresh,
  };
}
