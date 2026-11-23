import { cn } from '@/lib/utils';

const GLYPHS = '0123456789ABCDEF';

// Fixed layout so server and client render the same markup
const COLUMNS = Array.from({ length: 18 }, (_, i) => {
  const r = (n: number) => ((Math.sin(i * 12.9898 + n * 78.233) * 43758.5453) % 1 + 1) % 1;
  const length = 10 + Math.floor(r(6) * 14);
  const text = Array.from(
    { length },
    (_, j) => GLYPHS[Math.floor((((Math.sin((i + 1) * (j + 3) * 3.17) * 9301) % 1) + 1) % 1 * 16)]
  ).join('');
  return {
    left: `${(r(1) * 100).toFixed(2)}%`,
    size: `${(9 + r(2) * 5).toFixed(1)}px`,
    duration: `${(9 + r(3) * 12).toFixed(1)}s`,
    delay: `${(-r(4) * 20).toFixed(1)}s`,
    hot: i % 6 === 0,
    text,
  };
});

/**
 * Columns of hex drifting down behind hero surfaces: the cipher behind the mask.
 * CSS only, no canvas. (Name kept from the previous brand for existing imports.)
 */
export const HaloField = ({ className }: { className?: string }) => (
  <div className={cn('halo-field', className)} aria-hidden>
    {COLUMNS.map((c, i) => (
      <i
        key={i}
        data-hot={c.hot ? '' : undefined}
        style={
          {
            left: c.left,
            '--s': c.size,
            '--d': c.duration,
            '--delay': c.delay,
          } as React.CSSProperties
        }
      >
        {c.text}
      </i>
    ))}
  </div>
);
