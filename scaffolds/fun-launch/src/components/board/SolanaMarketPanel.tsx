import { useSolanaMarket } from '@/hooks/useMarket';
import { formatUsd, useSolPrice } from '@/hooks/useUsd';
import { sparklinePaths } from '@/lib/market';
import { cn } from '@/lib/utils';

const percent = new Intl.NumberFormat('en-US', {
  style: 'percent',
  maximumFractionDigits: 1,
  signDisplay: 'exceptZero',
});

export function SolanaMarketPanel() {
  const { data, isLoading } = useSolanaMarket();
  const { data: solPrice } = useSolPrice();
  const history = data?.hourlyCloses;
  const points = history?.value;
  const last = points?.at(-1);
  const price = solPrice ?? last;
  const change = points && last !== undefined ? last / points[0]! - 1 : null;
  const paths = points ? sparklinePaths(points, 360, 70, 3) : null;

  return (
    <section aria-label="Solana statistics" className="flex min-w-0 flex-col gap-2">
      <h2 className="eyebrow text-neutral-300">Solana</h2>
      <figure className="flex flex-1 flex-col border border-white/[0.08] bg-background/50 px-3 py-2.5">
        <figcaption className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
          <span className="font-term text-[10px] tracking-wider text-neutral-400">SOL / USD</span>
          <span
            className="font-mono text-lg font-semibold leading-none tabular-nums"
            title={
              solPrice === undefined && last !== undefined
                ? 'Last completed hourly close'
                : undefined
            }
          >
            {price !== undefined ? formatUsd(price) : '—'}
          </span>
          <span className="ml-auto font-mono text-[10px] text-neutral-500">
            {history?.stale ? 'Delayed · 24h' : '24h'}
          </span>
          {change !== null && (
            <span
              className={cn('font-mono text-[11px]', change < 0 ? 'text-rose' : 'text-emerald')}
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
            className="mt-2 block h-0 min-h-16 w-full flex-1 text-signal"
          >
            <title>Hourly SOL/USD closes from Coinbase Exchange</title>
            <path d="M0 18H360 M0 35H360 M0 52H360" className="stroke-white/10" />
            <path d={paths.area} fill="currentColor" opacity="0.14" />
            <path
              d={paths.line}
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinejoin="round"
              vectorEffect="non-scaling-stroke"
            />
          </svg>
        ) : (
          <p className="mt-2 grid min-h-16 flex-1 place-items-center text-xs text-neutral-500">
            {isLoading ? 'Loading price history…' : 'Price history unavailable'}
          </p>
        )}
      </figure>
    </section>
  );
}
