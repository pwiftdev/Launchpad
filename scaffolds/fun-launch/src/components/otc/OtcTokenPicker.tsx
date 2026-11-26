import { useId, useState } from 'react';
import { useInfiniteQuery } from '@tanstack/react-query';
import { Button } from '@/components/ui/button';
import { OFFICIAL_MSKD } from '@/constants/officialMskd';
import { otcRequest, type OtcToken, type OtcTokenPage } from '@/lib/otc';
import { OtcFeedback, otcField } from './OtcLayout';
import { useOtcAction } from './useOtcAction';

export function OtcTokenPicker({
  wallet,
  selected,
  disabled,
  onSelect,
}: {
  wallet: string;
  selected?: OtcToken;
  disabled: boolean;
  onSelect: (token?: OtcToken) => void;
}) {
  const catalog = useInfiniteQuery({
    queryKey: ['otc-assets', wallet],
    queryFn: ({ pageParam, signal }) =>
      otcRequest<OtcTokenPage>(
        { action: 'assets', after: typeof pageParam === 'string' ? pageParam : null },
        wallet,
        signal
      ),
    getNextPageParam: (page) => page.next ?? undefined,
    enabled: !selected,
    retry: false,
    staleTime: 60_000,
  });
  const { busy, error, run } = useOtcAction();
  const [query, setQuery] = useState('');
  const id = useId();
  const mint = query.trim();
  const isMint = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint);
  const search = mint.toLowerCase();
  const matches = (catalog.data?.pages.flatMap((page) => page.tokens) ?? []).filter(
    (coin) =>
      coin.mint !== OFFICIAL_MSKD.mint &&
      [coin.symbol, coin.mint].some((entry) => entry.toLowerCase().includes(search))
  );

  function choose(address: string) {
    void run(async (signal) => {
      const found = await otcRequest<OtcToken>({ action: 'asset', mint: address }, wallet, signal);
      signal.throwIfAborted();
      onSelect(found);
    });
  }

  if (selected)
    return (
      <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-neutral-800 bg-neutral-950 p-3">
        <div className="min-w-0">
          <p className="font-medium">{selected.symbol}</p>
          <p className="break-all font-mono text-xs text-neutral-300">{selected.mint}</p>
        </div>
        <Button type="button" variant="ghost" disabled={disabled} onClick={() => onSelect()}>
          Change token
        </Button>
      </div>
    );

  return (
    <div className="space-y-2">
      <label htmlFor={id} className="block text-sm font-medium">
        Launchpad token
      </label>
      <div className="flex flex-wrap gap-2 sm:flex-nowrap">
        <input
          className={otcField}
          id={id}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search or paste mint address"
          autoComplete="off"
          spellCheck={false}
          maxLength={44}
          disabled={disabled || busy}
        />
        {isMint && (
          <Button
            type="button"
            variant="outline"
            className="h-11"
            disabled={disabled || busy}
            onClick={() => choose(mint)}
          >
            Use mint
          </Button>
        )}
      </div>
      <ul
        className="flex max-h-36 flex-wrap gap-1.5 overflow-auto py-1"
        aria-label="Matching tokens"
      >
        {process.env.NEXT_PUBLIC_NETWORK === 'mainnet-beta' &&
          (!search ||
            OFFICIAL_MSKD.symbol.toLowerCase().includes(search) ||
            OFFICIAL_MSKD.name.toLowerCase().includes(search)) && (
            <li>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled || busy}
                onClick={() => choose(OFFICIAL_MSKD.mint)}
              >
                MSKD
              </Button>
            </li>
          )}
        {matches.map((coin) => (
          <li key={coin.mint}>
            <Button
              type="button"
              className="max-w-[13rem] overflow-hidden"
              title={coin.mint}
              variant="outline"
              size="sm"
              disabled={disabled || busy}
              onClick={() => choose(coin.mint)}
            >
              <span className="truncate">{coin.symbol}</span>
              <span className="shrink-0 text-neutral-400">
                {coin.mint.slice(0, 4)}…{coin.mint.slice(-4)}
              </span>
            </Button>
          </li>
        ))}
      </ul>
      {catalog.hasNextPage && (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={catalog.isFetching || disabled}
          onClick={() => void catalog.fetchNextPage()}
        >
          Load more tokens
        </Button>
      )}
      {catalog.isError && (
        <p className="text-xs text-neutral-300">
          The catalog couldn’t load. You can still paste a mint address.
        </p>
      )}
      <OtcFeedback
        error={error}
        notice={busy ? 'Checking the mint and Rings eligibility…' : undefined}
      />
    </div>
  );
}
