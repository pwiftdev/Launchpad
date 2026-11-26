import Link from 'next/link';
import { useRef } from 'react';
import { useCoins } from '@/hooks/useCoins';
import { useNow } from '@/hooks/useNow';
import { NETWORK, NETWORK_LABEL } from '@/constants/network';
import { formatUsd, useUsd } from '@/hooks/useUsd';
import { useLaunchpadMarket } from '@/hooks/useMarket';
import { POOL_RESERVES_DESCRIPTION } from '@/lib/market';
import { cn } from '@/lib/utils';

const number = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export const StatusBar = () => {
  const statsRef = useRef<HTMLDListElement>(null);
  const { data: coins } = useCoins();
  const { data, isFetching, preview, volume, swaps, liquidity, coverage } =
    useLaunchpadMarket(coins);
  const now = useNow(1000);
  const { usd, price } = useUsd();
  const age = now && data?.updatedAt ? now - data.updatedAt : null;
  const live = !!data?.network.slot && age !== null && age < 180;

  return (
    <footer
      aria-label="Market and Solana statistics"
      className="fixed inset-x-0 bottom-16 z-30 flex h-10 shrink-0 items-center gap-3 border-t border-white/[0.08] bg-panel px-3 text-[10px] md:static md:z-auto md:h-11 md:gap-4 md:px-4"
    >
      <div
        className="flex shrink-0 items-center gap-2 border-r border-neutral-800 pr-3"
        title={
          live
            ? 'Cluster statistics refreshed ' + Math.max(0, Math.round(age ?? 0)) + ' seconds ago'
            : 'Connecting to the configured Solana cluster'
        }
      >
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full',
            live ? 'bg-signal shadow-[0_0_8px_rgba(255,102,0,0.6)]' : 'bg-amber',
            isFetching && 'animate-pulse'
          )}
        />
        <span className="font-term font-medium uppercase tracking-wider text-neutral-300">
          {NETWORK === 'mainnet-beta' ? 'Solana' : NETWORK_LABEL}
        </span>
        <span className="hidden font-term text-neutral-500 lg:inline">
          {live ? 'connected' : 'syncing…'}
        </span>
      </div>
      <dl
        ref={statsRef}
        className="scrollbar-none flex min-w-0 flex-1 items-center gap-5 overflow-x-auto whitespace-nowrap"
      >
        <Stat
          label="SOL"
          value={price ? formatUsd(price) : '?'}
          accent
          icon="ph--currency-circle-dollar"
          title="SOL/USD market price; devnet SOL has no monetary value"
        />
        <Stat
          label={preview ? 'Sample vol.' : 'Recent vol.'}
          value={volume === null ? '?' : usd(volume)}
          title={coverage}
        />
        <Stat
          label={preview ? 'Sample swaps' : 'Tracked swaps'}
          value={swaps === null ? '?' : number.format(swaps)}
          title={coverage}
        />
        <Stat
          label={preview ? 'Preview reserves' : 'Pool reserves'}
          value={liquidity === undefined ? '?' : usd(liquidity)}
          title={POOL_RESERVES_DESCRIPTION}
        />
        <Stat
          label="TPS"
          value={data?.network.tps == null ? '?' : number.format(data.network.tps)}
          title={
            NETWORK_LABEL +
            ' transactions per second, including votes, from the latest RPC performance sample'
          }
        />
        <Stat
          label="RPC"
          value={data?.network.rpcMs == null ? '?' : data.network.rpcMs + ' ms'}
          title="Server-to-RPC getSlot round-trip time"
        />
        <Stat
          label="Slot"
          value={data?.network.slot ? number.format(data.network.slot) : '?'}
          title="Latest confirmed slot on the configured cluster"
        />
      </dl>
      <button
        type="button"
        aria-label="More market stats"
        onClick={() => statsRef.current?.scrollBy({ left: 220, behavior: 'smooth' })}
        className="flex h-7 w-6 shrink-0 items-center justify-center rounded text-neutral-400 hover:text-primary md:hidden"
      >
        <span className="iconify h-3.5 w-3.5 ph--caret-right-bold" />
      </button>
      <nav
        className="hidden shrink-0 items-center gap-3 border-l border-neutral-800 pl-4 font-term uppercase tracking-wider text-neutral-500 xl:flex"
        aria-label="Footer links"
      >
        <Link href="/rules" className="hover:text-primary">
          Rules
        </Link>
      </nav>
    </footer>
  );
};

function Stat({
  label,
  value,
  title,
  accent,
  icon,
}: {
  label: string;
  value: string;
  title?: string;
  accent?: boolean;
  icon?: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-1.5" title={title}>
      {icon && <span aria-hidden className={cn('iconify h-3.5 w-3.5', icon, 'text-primary')} />}
      <dt className="font-term uppercase tracking-wider text-neutral-500">{label}</dt>
      <dd
        className={cn(
          'font-mono font-medium tabular',
          accent ? 'text-primary' : 'text-neutral-200'
        )}
      >
        {value}
      </dd>
    </div>
  );
}
