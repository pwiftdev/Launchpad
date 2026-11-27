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
      className="fixed inset-x-0 bottom-[76px] z-30 flex h-9 shrink-0 items-center gap-3 border-y border-white/[0.06] bg-[rgb(18_15_14/0.72)] px-3 text-[10.5px] backdrop-blur-xl md:glass md:relative md:inset-auto md:z-auto md:h-10 md:gap-4 md:rounded-2xl md:border md:px-4"
    >
      <div
        className="flex shrink-0 items-center gap-2 border-r border-white/[0.07] pr-3"
        title={
          live
            ? 'Cluster statistics refreshed ' + Math.max(0, Math.round(age ?? 0)) + ' seconds ago'
            : 'Connecting to the configured Solana cluster'
        }
      >
        <span
          className={cn(
            'h-2 w-2 rounded-full',
            live ? 'bg-emerald shadow-[0_0_10px_rgba(62,222,140,0.7)]' : 'bg-amber',
            isFetching && 'animate-pulse'
          )}
        />
        <span className="font-medium text-neutral-200">
          {NETWORK === 'mainnet-beta' ? 'Solana' : NETWORK_LABEL}
        </span>
        <span className="hidden text-neutral-500 lg:inline">{live ? 'connected' : 'syncing…'}</span>
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
        className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg text-neutral-400 hover:text-primary md:hidden"
      >
        <span className="iconify h-3.5 w-3.5 ph--caret-right-bold" />
      </button>
      <nav
        className="hidden shrink-0 items-center gap-4 border-l border-white/[0.07] pl-4 text-neutral-400 xl:flex"
        aria-label="Footer links"
      >
        <Link href="/proof" className="transition-colors hover:text-primary">
          Proof
        </Link>
        <Link href="/rules" className="transition-colors hover:text-primary">
          Rules
        </Link>
        <Link href="/privacy" className="transition-colors hover:text-primary">
          Privacy
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
      <dt className="text-neutral-500">{label}</dt>
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
