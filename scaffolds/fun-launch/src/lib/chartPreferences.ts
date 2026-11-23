export const CHART_INTERVALS = [1, 5, 15, 60, 300, 900, 3600, 14400, 86400] as const;
export const CHART_PREFERENCES_KEY = 'rinsed:chart:v1';
export type ChartPreferences = {
  interval: number;
  style: 'candles' | 'line';
  metric: 'price' | 'marketCap';
  currency: 'SOL' | 'USD';
  volume: boolean;
  logarithmic: boolean;
};
export const DEFAULT_CHART_PREFERENCES: ChartPreferences = {
  interval: 5,
  style: 'candles',
  metric: 'marketCap',
  currency: 'SOL',
  volume: true,
  logarithmic: false,
};
export function parseChartPreferences(value: string | null): ChartPreferences {
  const defaults = { ...DEFAULT_CHART_PREFERENCES };
  if (!value || value.length > 2048) return defaults;
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return defaults;
    const p = parsed as Record<string, unknown>;
    return {
      interval: CHART_INTERVALS.some((i) => i === p.interval)
        ? Number(p.interval)
        : defaults.interval,
      style: p.style === 'line' ? 'line' : defaults.style,
      metric: p.metric === 'price' ? 'price' : defaults.metric,
      currency: p.currency === 'USD' ? 'USD' : defaults.currency,
      volume: typeof p.volume === 'boolean' ? p.volume : defaults.volume,
      logarithmic: typeof p.logarithmic === 'boolean' ? p.logarithmic : defaults.logarithmic,
    };
  } catch {
    return defaults;
  }
}

type Range = { from: number; to: number };
/** Anchor a scrolled view to a real timestamp when polling prepends or drops history. */
export function retainChartRange(
  previous: readonly number[],
  next: readonly number[],
  range: Range | null,
  follow: boolean
): Range | null {
  if (!next.length) return null;
  if (!range || !previous.length)
    return { from: Math.max(-1, next.length - 80), to: next.length + 3 };
  if (follow) {
    const width = Math.max(5, range.to - range.from);
    return { from: next.length + 3 - width, to: next.length + 3 };
  }
  const anchor = Math.max(0, Math.min(previous.length - 1, Math.floor(range.from)));
  const time = previous[anchor];
  const newIndex = next.findIndex((value) => value === time);
  // Retain the time window, rather than jump to live, if a bounded feed evicts its anchor.
  const nearest =
    newIndex >= 0
      ? newIndex
      : Math.max(
          0,
          next.findIndex((value) => value >= (time ?? 0))
        );
  const shift = nearest - anchor;
  return { from: range.from + shift, to: range.to + shift };
}
