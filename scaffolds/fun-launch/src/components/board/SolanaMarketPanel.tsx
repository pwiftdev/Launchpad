import { useSolanaMarket } from '@/hooks/useMarket';
import { formatUsd, useSolPrice } from '@/hooks/useUsd';
import { sparklinePaths } from '@/lib/market';
import { cn } from '@/lib/utils';

const percent = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 1,
  signDisplay: 'exceptZero',
});

export function SolanaMarketPanel({ className }: { className?: string }) {
  const { data, isLoading } = useSolanaMarket();
  const { data: solPrice } = useSolPrice();
  const history = data?.hourlyCloses;
  const points = history?.value;
  const last = points?.at(-1);
  const price = solPrice ?? last;
  const change = points && last !== undefined ? last / points[0]! - 1 : null;
  const paths = points ? sparklinePaths(points, 360, 70, 3) : null;

  return (
    <section
      aria-label="Solana statistics"
      className={cn('flex min-w-0 flex-col gap-2.5', className)}
    >
      <h2 className="eyebrow">Solana</h2>
      {/* Grows to the height of the launchpad tiles beside it; the chart fills the extra room */}
      <figure className="tile relative flex flex-1 flex-col overflow-hidden px-3.5 pb-0 pt-3">
        <figcaption className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="text-[11px] text-neutral-400">SOL / USD</span>
          <span
            className="font-mono text-[20px] font-semibold leading-none tracking-tight tabular-nums 2xl:text-[24px]"
            title={
              solPrice === undefined && last !== undefined
                ? 'Last completed hourly close'
                : undefined
            }
          >
            {price !== undefined ? formatUsd(price) : '—'}
          </span>
          <span className="ml-auto font-mono text-[10.5px] text-neutral-500">
            {history?.stale ? 'Delayed · 24h' : '24h'}
          </span>
          {change !== null && (
            <span
              className={cn(
                'rounded-full px-1.5 py-px font-mono text-[10.5px] font-semibold',
                change < 0 ? 'bg-rose/10 text-rose' : 'bg-emerald/10 text-emerald'
              )}
            >
              {percent.format(change)}
            </span>
          )}
        </figcaption>
        {paths ? (
          <svg
            role="img"
            aria-label="SOL/USD price over the last 24 completed hours"
            viewBox="0 0 360 70"
            preserveAspectRatio="none"
            className="-mx-3.5 mt-2 block min-h-[5.75rem] w-[calc(100%+1.75rem)] flex-1 text-signal"
          >
            <title>Hourly SOL/USD closes from Coinbase Exchange</title>
            <defs>
              <linearGradient id="sol-area" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#ff6a0a" stopOpacity="0.42" />
                <stop offset="100%" stopColor="#ff6a0a" stopOpacity="0" />
              </linearGradient>
              <filter id="sol-glow" x="-10%" y="-40%" width="120%" height="180%">
                <feGaussianBlur stdDeviation="2.4" />
              </filter>
            </defs>
            <path d="M0 23H360 M0 46H360" className="stroke-white/[0.06]" strokeDasharray="2 4" />
            <path d={paths.area} fill="url(#sol-area)" />
            <path
              d={paths.line}
              fill="none"
              stroke="#ff7a1a"
              strokeWidth="3"
              opacity="0.55"
              filter="url(#sol-glow)"
              vectorEffect="non-scaling-stroke"
            />
            <path
              d={paths.line}
              fill="none"
              stroke="#ff8f45"
              strokeWidth="1.75"
              strokeLinejoin="round"
              strokeLinecap="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        ) : (
          <p className="mt-2 grid min-h-[5.75rem] flex-1 place-items-center pb-3 text-xs text-neutral-500">
            {isLoading ? 'Loading price history…' : 'Price history unavailable'}
          </p>
        )}
      </figure>
      {/* Mirrors the launchpad footnote, so both cards end on the same line */}
      <p className="flex items-center gap-1.5 text-[11px] text-neutral-500">
        <span aria-hidden className="h-1.5 w-1.5 rounded-full bg-neutral-600" />
        Hourly closes from Coinbase Exchange
      </p>
    </section>
  );
}
