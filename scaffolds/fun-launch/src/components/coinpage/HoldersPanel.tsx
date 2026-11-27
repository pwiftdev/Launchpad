import { useState } from 'react';
import { useHolders } from '@/hooks/useCoins';
import { explorerUrl } from '@/constants/network';
import type { Coin } from '@/lib/coin';
import { formatReadableNumber } from '@/lib/format/number';
import { displayShare, holderSupplyShare } from '@/lib/tokenActivity';
import { shortenAddress } from '@/lib/utils';

export function HoldersPanel({ coin }: { coin: Coin }) {
  const [open, setOpen] = useState(false);
  const { data, isLoading, isError, refetch } = useHolders(open ? coin.mint : undefined);
  return (
    <details
      className="surface group/holders rounded-3xl px-4 py-1 sm:px-5"
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="flex h-14 cursor-pointer list-none items-center gap-2 text-[15px] font-semibold tracking-tight text-foreground [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="iconify h-4 w-4 text-neutral-400 ph--users-three" />
        Top holders
        <span
          aria-hidden
          className="iconify ml-auto h-4 w-4 text-neutral-500 transition-transform duration-300 ease-spring group-open/holders:rotate-180 ph--caret-down-bold"
        />
      </summary>
      {open && (
        <div className="animate-in fade-in slide-in-from-top-1 pb-4 duration-300">
          {isLoading ? <p className="text-sm text-neutral-400">Loading holders…</p> : null}
          {isError && (
            <p className="text-sm text-neutral-400">
              Holders unavailable.{' '}
              <button
                type="button"
                className="text-primary underline"
                onClick={() => void refetch()}
              >
                Retry
              </button>
            </p>
          )}
          {data && data.holders.length > 0 && (
            <>
              <p className="text-xs text-neutral-400">
                {data.partial ? `Top ${data.holders.length} of ` : ''}
                {(data.holderCount ?? data.holders.length).toLocaleString('en-US')} holders · Share
                of total supply
              </p>
              <ul className="mt-2 space-y-0.5 text-sm">
                {data.holders.map((holder) => (
                  <li
                    key={holder.owner}
                    className="-mx-2 flex items-center justify-between gap-3 rounded-xl px-2 py-2 font-mono transition-colors duration-200 hover:bg-white/[0.04]"
                  >
                    {coin.isDemo ? (
                      <span>{shortenAddress(holder.owner)}</span>
                    ) : (
                      <a
                        className="text-neutral-300 hover:text-primary"
                        href={explorerUrl(`address/${holder.owner}`)}
                        target="_blank"
                        rel="noreferrer"
                        title={holder.owner}
                      >
                        {shortenAddress(holder.owner)}
                      </a>
                    )}
                    <span className="text-neutral-400">
                      {formatReadableNumber(holder.amount)} ·{' '}
                      {displayShare(
                        holderSupplyShare(holder, data.tokenSupply ?? coin.tokenSupply)
                      )}
                    </span>
                  </li>
                ))}
              </ul>
              {data.updatedAt && (
                <p className="mt-2 text-xs text-neutral-500">
                  {data.stale ? 'Last available snapshot · ' : 'Snapshot · '}
                  {new Date(data.updatedAt * 1000).toLocaleString()}
                </p>
              )}
            </>
          )}
          {data?.holders.length === 0 && (
            <p className="text-sm text-neutral-400">
              {data.stale ? 'Waiting for a holder snapshot.' : 'No holders in the latest snapshot.'}
            </p>
          )}
        </div>
      )}
    </details>
  );
}
