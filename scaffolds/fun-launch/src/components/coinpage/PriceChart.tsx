import { useId, useMemo, useRef, useState } from 'react';
import type { CoinPriceHistory } from '@/lib/coin';
import { formatReadableNumber } from '@/lib/format/number';
import { sparklinePaths } from '@/lib/market';
import { cn } from '@/lib/utils';

const chartTime = new Intl.DateTimeFormat('en', {
  day: 'numeric',
  month: 'short',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});
const hoverTime = new Intl.DateTimeFormat('en', {
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
  timeZone: 'UTC',
});

const WIDTH = 600;
const HEIGHT = 200;
const PADDING = 6;

export function PriceChart({
  history,
  isLoading,
  error,
  onRetry,
}: {
  history?: CoinPriceHistory;
  isLoading?: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  const points = history?.points ?? [];
  const first = points[0];
  const last = points.at(-1);
  const recent = history?.range === 'recent';
  const change =
    first && last && points.length > 1 && first.priceSol > 0
      ? last.priceSol / first.priceSol - 1
      : null;
  return (
    <section aria-label="Token price history" className="surface rounded-3xl p-4 sm:p-5">
      <header className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <h3 className="text-[15px] font-semibold tracking-tight text-foreground">Price</h3>
        <span className="chip">{recent ? 'Recent trades' : '24h'}</span>
        {change !== null && (
          <span
            className={cn(
              'inline-flex items-center gap-0.5 rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold',
              change < 0 ? 'bg-rose/10 text-rose' : 'bg-emerald/10 text-emerald'
            )}
          >
            <span
              aria-hidden
              className={cn(
                'iconify h-3 w-3',
                change < 0 ? 'ph--arrow-down-right-bold' : 'ph--arrow-up-right-bold'
              )}
            />
            {Math.abs(change * 100).toFixed(change !== 0 && Math.abs(change) < 0.1 ? 2 : 1)}%
          </span>
        )}
        {history && (history.stale || !!error) && (
          <p role="status" className="ml-auto flex items-center gap-1.5 text-xs text-amber">
            <span aria-hidden className="h-1.5 w-1.5 animate-pulse rounded-full bg-amber" />
            Price updates delayed
          </p>
        )}
      </header>
      {points.length > 1 ? (
        <PriceLine points={points} down={(change ?? 0) < 0} recent={recent} />
      ) : last ? (
        <div className="mt-3 rounded-2xl border border-white/[0.08] p-4">
          <p className="text-sm text-neutral-400">Latest trade price</p>
          <p className="mt-1 font-mono text-lg">{formatReadableNumber(last.priceSol)} SOL</p>
          <p className="mt-1 text-xs text-neutral-400">{chartTime.format(last.time * 1000)} UTC</p>
        </div>
      ) : (
        <div className="mt-3 flex min-h-48 flex-col items-center justify-center gap-3 rounded-2xl border border-dashed border-white/[0.08] text-center text-sm text-neutral-400 sm:min-h-56">
          {isLoading ? (
            <>
              <span className="skeleton h-1.5 w-40" />
              Loading price history…
            </>
          ) : error ? (
            'Price history unavailable.'
          ) : (
            <>
              <span aria-hidden className="iconify h-6 w-6 text-neutral-600 ph--chart-line" />
              Waiting for more trades.
            </>
          )}
          {!!error && onRetry && (
            <button type="button" className="btn-glass h-8 px-3 text-xs" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function PriceLine({
  points,
  down,
  recent,
}: {
  points: CoinPriceHistory['points'];
  down: boolean;
  recent: boolean;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const host = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const values = points.map(({ priceSol }) => priceSol);
  const start = points[0]!;
  const end = points.at(-1)!;
  const duration = end.time - start.time;
  const offsets =
    duration > 0 ? points.map(({ time }) => (time - start.time) / duration) : undefined;
  const paths = sparklinePaths(values, WIDTH, HEIGHT, PADDING, offsets);
  // The same placement the line uses, as fractions of the box, for the hover marker
  const positions = useMemo(() => {
    const min = Math.min(...values);
    const range = Math.max(...values) - min;
    return values.map((value, i) => ({
      x: (PADDING + (offsets?.[i] ?? i / (values.length - 1)) * (WIDTH - PADDING * 2)) / WIDTH,
      y:
        (range ? HEIGHT - PADDING - ((value - min) / range) * (HEIGHT - PADDING * 2) : HEIGHT / 2) /
        HEIGHT,
    }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [points]);
  if (!paths) return null;

  function track(event: React.PointerEvent) {
    const box = host.current?.getBoundingClientRect();
    if (!box) return;
    const x = (event.clientX - box.left) / box.width;
    let nearest = 0;
    for (let i = 1; i < positions.length; i++)
      if (Math.abs(positions[i]!.x - x) < Math.abs(positions[nearest]!.x - x)) nearest = i;
    setHover(nearest);
  }

  const shown = hover === null ? null : points[hover]!;
  const marker = hover === null ? null : positions[hover]!;
  return (
    <figure className="mt-3">
      <div
        ref={host}
        className={cn('relative touch-none select-none', down ? 'text-rose' : 'text-emerald')}
        onPointerMove={track}
        onPointerDown={track}
        onPointerLeave={() => setHover(null)}
      >
        <svg
          role="img"
          aria-label={
            recent
              ? 'Recent recorded token prices in SOL'
              : 'Recorded token prices in SOL over the past 24 hours'
          }
          viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
          preserveAspectRatio="none"
          className="h-52 w-full overflow-visible sm:h-64"
        >
          <defs>
            <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="currentColor" stopOpacity="0.28" />
              <stop offset="70%" stopColor="currentColor" stopOpacity="0.04" />
              <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
            </linearGradient>
          </defs>
          <path
            d={`M0 ${HEIGHT * 0.25}H${WIDTH} M0 ${HEIGHT * 0.5}H${WIDTH} M0 ${HEIGHT * 0.75}H${WIDTH}`}
            stroke="rgb(255 255 255 / 0.05)"
            strokeDasharray="3 6"
            vectorEffect="non-scaling-stroke"
          />
          <path d={paths.area} fill={`url(#${id})`} />
          <path
            d={paths.line}
            fill="none"
            stroke="currentColor"
            strokeWidth="6"
            strokeOpacity="0.18"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
          <path
            d={paths.line}
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            vectorEffect="non-scaling-stroke"
          />
        </svg>
        {marker && shown && (
          <>
            <span
              aria-hidden
              className="pointer-events-none absolute inset-y-0 w-px bg-gradient-to-b from-transparent via-white/30 to-transparent"
              style={{ left: `${marker.x * 100}%` }}
            />
            <span
              aria-hidden
              className="pointer-events-none absolute h-3 w-3 -translate-x-1/2 -translate-y-1/2 rounded-full bg-current shadow-[0_0_0_4px_rgba(255,255,255,0.12),0_0_16px_currentColor] ring-2 ring-background"
              style={{ left: `${marker.x * 100}%`, top: `${marker.y * 100}%` }}
            />
            <span
              className="glass-strong pointer-events-none absolute top-0 z-10 -translate-x-1/2 whitespace-nowrap rounded-xl px-2.5 py-1.5 text-center"
              style={{ left: `${Math.min(Math.max(marker.x * 100, 12), 88)}%` }}
            >
              <span className="block font-mono text-[12.5px] font-semibold text-foreground">
                {formatReadableNumber(shown.priceSol)} SOL
              </span>
              <span className="block font-mono text-[10.5px] text-neutral-400">
                {hoverTime.format(shown.time * 1000)} UTC
              </span>
            </span>
          </>
        )}
      </div>
      <figcaption className="mt-2 flex flex-wrap justify-between gap-2 font-mono text-[11px] text-neutral-500">
        <span>{chartTime.format(start.time * 1000)} UTC</span>
        <span className="text-neutral-400">
          {formatReadableNumber(start.priceSol)} → {formatReadableNumber(end.priceSol)} SOL
        </span>
        <span>{chartTime.format(end.time * 1000)} UTC</span>
      </figcaption>
    </figure>
  );
}
