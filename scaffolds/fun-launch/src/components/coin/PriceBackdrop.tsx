import { useId, useMemo } from 'react';
import { sparklinePaths } from '@/lib/market';
import { cn } from '@/lib/utils';

/** A decorative rendering of observed prices; all numeric context stays in readable foreground text. */
export function PriceBackdrop({
  points,
  down = false,
  className,
}: {
  points: number[];
  down?: boolean;
  className?: string;
}) {
  const id = useId().replace(/[^a-zA-Z0-9]/g, '');
  const paths = useMemo(() => sparklinePaths(points), [points]);
  if (!paths) return null;
  return (
    <svg
      aria-hidden="true"
      focusable="false"
      viewBox="0 0 240 90"
      preserveAspectRatio="none"
      data-price-backdrop="true"
      className={cn('pointer-events-none', down ? 'text-neutral-500' : 'text-signal', className)}
    >
      <defs>
        <linearGradient id={`${id}-fill`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="currentColor" stopOpacity="0.24" />
          <stop offset="100%" stopColor="currentColor" stopOpacity="0" />
        </linearGradient>
        <linearGradient id={`${id}-fade`}>
          <stop offset="0%" stopColor="white" stopOpacity="0" />
          <stop offset="45%" stopColor="white" />
        </linearGradient>
        <mask id={`${id}-mask`}>
          <rect width="240" height="90" fill={`url(#${id}-fade)`} />
        </mask>
      </defs>
      <g mask={`url(#${id}-mask)`}>
        <path d={paths.area} fill={`url(#${id}-fill)`} />
        <path
          d={paths.line}
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </g>
    </svg>
  );
}
