import { useEffect, useMemo, useRef, useState } from 'react';
import { useTheme } from 'next-themes';
import type { IChartApi, ISeriesApi, UTCTimestamp } from 'lightweight-charts';
import type { Coin, TradesResponse } from '@/lib/coin';
import { buildTradeBars, chartValueMultiplier } from '@/lib/candles';
import {
  CHART_INTERVALS,
  CHART_PREFERENCES_KEY,
  DEFAULT_CHART_PREFERENCES,
  parseChartPreferences,
  retainChartRange,
  type ChartPreferences,
} from '@/lib/chartPreferences';
import { useSolPrice } from '@/hooks/useUsd';
import { quoteAsset } from '@/lib/feeModes';
import { cn } from '@/lib/utils';

const UP = '#2EE6A6';
const DOWN = '#FF4D78';
const LINE = '#16D9F5';
const SUBSCRIPT = '₀₁₂₃₄₅₆₇₈₉';
const MIN_INITIAL_BARS = 60;

const intervalLabel = (seconds: number) =>
  seconds < 60
    ? `${seconds}s`
    : seconds < 3600
      ? `${seconds / 60}m`
      : seconds < 86400
        ? `${seconds / 3600}h`
        : '1d';

/** Compact values; tiny prices use subscript zeros (0.0₇2599) instead of exponents. */
export const formatValue = (value: number) => {
  if (!Number.isFinite(value)) return '--';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 1e9) return `${sign}${Number((abs / 1e9).toPrecision(4))}B`;
  if (abs >= 1e6) return `${sign}${Number((abs / 1e6).toPrecision(4))}M`;
  if (abs >= 1e4) return `${sign}${Number((abs / 1e3).toPrecision(4))}K`;
  if (abs >= 1) return `${sign}${Number(abs.toPrecision(5))}`;
  if (abs === 0) return '0';
  const zeros = Math.floor(-Math.log10(abs));
  const digits =
    Math.round(abs * 10 ** (zeros + 4))
      .toString()
      .replace(/0+$/, '') || '0';
  if (zeros < 4) return `${sign}${Number(abs.toPrecision(4))}`;
  const sub = String(zeros)
    .split('')
    .map((d) => SUBSCRIPT[Number(d)])
    .join('');
  return `${sign}0.0${sub}${digits}`;
};

/**
 * Axis format for one market level: a fixed unit and decimal count, so every tick on the
 * scale reads alike (25.692, 25.700, 25.704) instead of trimming zeros tick by tick.
 */
export const scaleFormat = (reference: number | undefined) => {
  const abs = Math.abs(reference ?? 0);
  if (!Number.isFinite(abs) || abs < 1e-3)
    return {
      minMove: abs > 0 ? Math.max(10 ** (Math.floor(Math.log10(abs)) - 4), 1e-15) : 1e-12,
      formatter: formatValue,
    };
  const [divisor, suffix] =
    abs >= 1e9 ? [1e9, 'B'] : abs >= 1e6 ? [1e6, 'M'] : abs >= 1e4 ? [1e3, 'K'] : [1, ''];
  const decimals = Math.min(Math.max(4 - Math.floor(Math.log10(abs / divisor)), 0), 8);
  return {
    minMove: divisor * 10 ** -decimals,
    formatter: (value: number) =>
      Number.isFinite(value) ? `${(value / divisor).toFixed(decimals)}${suffix}` : '--',
  };
};

type PriceChartProps = {
  coin: Coin;
  trades: TradesResponse | undefined;
  isLoading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  className?: string;
};

/** Recorded post-swap prices. USD and market cap are explicitly current-rate normalizations. */
export const PriceChart = (props: PriceChartProps) => (
  // A mint change resets only transient view/crosshair state, never user settings.
  <TokenChart key={props.coin.mint} {...props} />
);

const TokenChart = ({ coin, trades, isLoading, error, onRetry, className }: PriceChartProps) => {
  const host = useRef<HTMLDivElement>(null);
  const chart = useRef<IChartApi | null>(null);
  const candleSeries = useRef<ISeriesApi<'Candlestick'> | null>(null);
  const areaSeries = useRef<ISeriesApi<'Area'> | null>(null);
  const volumeSeries = useRef<ISeriesApi<'Histogram'> | null>(null);
  const previousTimes = useRef<number[]>([]);
  const follow = useRef(true);
  const changingData = useRef(false);
  const [following, setFollowing] = useState(true);
  const [ready, setReady] = useState(0);
  const [preferences, setPreferences] = useState<ChartPreferences>({
    ...DEFAULT_CHART_PREFERENCES,
  });
  const [preferencesLoaded, setPreferencesLoaded] = useState(false);
  const [storageUnavailable, setStorageUnavailable] = useState(false);
  const [chartError, setChartError] = useState(false);
  const [hoverTime, setHoverTime] = useState<number | null>(null);
  const { resolvedTheme } = useTheme();
  const dark = resolvedTheme !== 'light';
  const { data: solPrice, isError: usdError } = useSolPrice();

  useEffect(() => {
    try {
      setPreferences(parseChartPreferences(localStorage.getItem(CHART_PREFERENCES_KEY)));
    } catch {
      setStorageUnavailable(true);
    }
    setPreferencesLoaded(true);
  }, []);
  useEffect(() => {
    if (!preferencesLoaded) return;
    try {
      localStorage.setItem(CHART_PREFERENCES_KEY, JSON.stringify(preferences));
    } catch {
      setStorageUnavailable(true);
    }
  }, [preferences, preferencesLoaded]);
  const update = <K extends keyof ChartPreferences>(key: K, value: ChartPreferences[K]) =>
    setPreferences((previous) => ({ ...previous, [key]: value }));

  const bars = useMemo(
    () => buildTradeBars(trades?.trades ?? [], preferences.interval),
    [trades?.trades, preferences.interval]
  );
  const quoteUnit = quoteAsset(coin.quoteMint).symbol;
  const quoteToSol = trades?.quoteToSol ?? coin.quoteToSol ?? 1;
  const chartCurrency = preferences.currency === 'USD' ? 'USD' : quoteUnit;
  const baseMultiplier = chartValueMultiplier(
    preferences.metric,
    preferences.currency,
    coin.tokenSupply,
    solPrice
  );
  const multiplier =
    baseMultiplier === null || preferences.currency === 'USD'
      ? baseMultiplier
      : baseMultiplier / quoteToSol;
  const candles = useMemo(
    () =>
      multiplier === null
        ? []
        : bars.map((bar) => ({
            time: bar.time as UTCTimestamp,
            open: bar.open * multiplier,
            high: bar.high * multiplier,
            low: bar.low * multiplier,
            close: bar.close * multiplier,
          })),
    [bars, multiplier]
  );

  useEffect(() => {
    let disposed = false;
    let ownChart: IChartApi | undefined;
    import('lightweight-charts')
      .then(({ createChart, ColorType, CrosshairMode, LineStyle }) => {
        if (disposed || !host.current) return;
        const c = createChart(host.current, {
          autoSize: true,
          layout: {
            background: { type: ColorType.Solid, color: 'transparent' },
            textColor: '#91A0BD',
            fontSize: 11,
            fontFamily: getComputedStyle(document.body).fontFamily,
            attributionLogo: false,
          },
          grid: { vertLines: { visible: false } },
          rightPriceScale: {
            borderVisible: false,
            scaleMargins: { top: 0.14, bottom: 0.24 },
            entireTextOnly: true,
          },
          timeScale: {
            borderVisible: false,
            timeVisible: true,
            secondsVisible: true,
            rightOffset: 6,
            barSpacing: 9,
            minBarSpacing: 2,
            shiftVisibleRangeOnNewBar: false,
          },
          crosshair: {
            mode: CrosshairMode.Normal,
            vertLine: { style: LineStyle.Dashed, width: 1, labelBackgroundColor: '#1B2236' },
            horzLine: { style: LineStyle.Dashed, width: 1, labelBackgroundColor: '#1B2236' },
          },
          handleScale: { axisPressedMouseMove: true, mouseWheel: true, pinch: true },
          handleScroll: {
            mouseWheel: true,
            pressedMouseMove: true,
            horzTouchDrag: true,
            vertTouchDrag: false,
          },
          localization: { priceFormatter: formatValue },
        });
        ownChart = c;
        chart.current = c;
        const priceFormat = { type: 'custom' as const, minMove: 1e-12, formatter: formatValue };
        candleSeries.current = c.addCandlestickSeries({
          upColor: UP,
          downColor: DOWN,
          borderVisible: false,
          wickUpColor: UP,
          wickDownColor: DOWN,
          priceLineStyle: LineStyle.Dotted,
          priceFormat,
        });
        areaSeries.current = c.addAreaSeries({
          lineColor: LINE,
          topColor: 'rgba(22,217,245,0.28)',
          bottomColor: 'rgba(22,217,245,0)',
          lineWidth: 2,
          priceLineStyle: LineStyle.Dotted,
          visible: false,
          priceFormat,
        });
        volumeSeries.current = c.addHistogramSeries({
          priceScaleId: 'volume',
          priceFormat: { type: 'volume' },
          lastValueVisible: false,
          priceLineVisible: false,
        });
        c.priceScale('volume').applyOptions({
          scaleMargins: { top: 0.8, bottom: 0 },
          visible: false,
        });
        c.subscribeCrosshairMove((event) =>
          setHoverTime(typeof event.time === 'number' ? event.time : null)
        );
        c.timeScale().subscribeVisibleLogicalRangeChange((range) => {
          if (changingData.current || !range || !previousTimes.current.length) return;
          follow.current = range.to >= previousTimes.current.length - 1;
          setFollowing(follow.current);
        });
        setReady((n) => n + 1);
      })
      .catch(() => {
        if (!disposed) setChartError(true);
      });
    return () => {
      disposed = true;
      ownChart?.remove();
      chart.current = null;
      candleSeries.current = null;
      areaSeries.current = null;
      volumeSeries.current = null;
    };
  }, []);

  // Styling changes keep the chart and its pan/zoom state intact.
  useEffect(() => {
    const text = dark ? '#7D8BA8' : '#5A6B8C';
    const grid = dark ? 'rgba(145,160,189,0.06)' : 'rgba(90,107,140,0.08)';
    const cross = dark ? 'rgba(145,160,189,0.45)' : 'rgba(90,107,140,0.5)';
    chart.current?.applyOptions({
      layout: { textColor: text },
      grid: { horzLines: { color: grid } },
      crosshair: { vertLine: { color: cross }, horzLine: { color: cross } },
      timeScale: { secondsVisible: preferences.interval < 60 },
      rightPriceScale: {
        mode: preferences.logarithmic ? 1 : 0,
        scaleMargins: { top: 0.14, bottom: preferences.volume ? 0.24 : 0.08 },
      },
    });
    candleSeries.current?.applyOptions({ visible: preferences.style === 'candles' });
    areaSeries.current?.applyOptions({ visible: preferences.style === 'line' });
    volumeSeries.current?.applyOptions({ visible: preferences.volume });
  }, [
    dark,
    preferences.style,
    preferences.logarithmic,
    preferences.volume,
    preferences.interval,
    ready,
  ]);

  const previousInterval = useRef(preferences.interval);
  useEffect(() => {
    const c = chart.current;
    if (!c || !candleSeries.current || !areaSeries.current || !volumeSeries.current) return;
    const times = candles.map((bar) => Number(bar.time));
    const intervalChanged = previousInterval.current !== preferences.interval;
    const fresh = intervalChanged || !previousTimes.current.length;
    const retained = retainChartRange(
      fresh ? [] : previousTimes.current,
      times,
      c.timeScale().getVisibleLogicalRange(),
      follow.current
    );
    // A young coin opens at a normal candle width, not a handful of bars stretched edge to edge.
    const range =
      retained && fresh && retained.to - retained.from < MIN_INITIAL_BARS
        ? { from: retained.to - MIN_INITIAL_BARS, to: retained.to }
        : retained;
    // Axis precision follows the magnitude of the market, from 0.0₈ SOL prices to $M caps.
    const { minMove, formatter } = scaleFormat(candles[candles.length - 1]?.close);
    const priceFormat = { type: 'custom' as const, minMove, formatter };
    changingData.current = true;
    try {
      c.applyOptions({ localization: { priceFormatter: formatter } });
      candleSeries.current.applyOptions({ priceFormat });
      areaSeries.current.applyOptions({ priceFormat });
      candleSeries.current.setData(candles);
      areaSeries.current.setData(candles.map((bar) => ({ time: bar.time, value: bar.close })));
      volumeSeries.current.setData(
        multiplier === null
          ? []
          : bars.map((bar) => ({
              time: bar.time as UTCTimestamp,
              value: bar.volumeSol / quoteToSol,
              color: bar.close >= bar.open ? 'rgba(46,230,166,0.32)' : 'rgba(255,77,120,0.32)',
            }))
      );
      previousTimes.current = times;
      previousInterval.current = preferences.interval;
      if (range) c.timeScale().setVisibleLogicalRange(range);
    } finally {
      changingData.current = false;
    }
  }, [candles, bars, multiplier, preferences.interval, quoteToSol, ready]);

  const activeIndex =
    hoverTime === null
      ? candles.length - 1
      : candles.findIndex((bar) => Number(bar.time) === hoverTime);
  const active = candles[activeIndex] ?? candles[candles.length - 1];
  const activeBar = bars[activeIndex] ?? bars[bars.length - 1];
  const change = active && active.open > 0 ? (active.close / active.open - 1) * 100 : null;
  const legend = scaleFormat(candles[candles.length - 1]?.close).formatter;
  const zoom = (factor: number) => {
    const scale = chart.current?.timeScale();
    const range = scale?.getVisibleLogicalRange();
    if (!scale || !range) return;
    const middle = (range.from + range.to) / 2;
    const half = Math.max(2, ((range.to - range.from) * factor) / 2);
    scale.setVisibleLogicalRange({ from: middle - half, to: middle + half });
  };
  const live = () => {
    follow.current = true;
    setFollowing(true);
    const scale = chart.current?.timeScale();
    const range = retainChartRange(
      previousTimes.current,
      previousTimes.current,
      scale?.getVisibleLogicalRange() ?? null,
      true
    );
    if (range) scale?.setVisibleLogicalRange(range);
  };
  const dataError = Boolean(error);
  const loading = isLoading ?? !trades;
  const noValues = multiplier === null;
  const delayed = (dataError || trades?.stale) && trades;
  const methodology = [
    'Post-swap prices; only intervals with recorded swaps are shown.',
    preferences.metric === 'marketCap'
      ? 'Market cap uses current verified supply, including older prices.'
      : '',
    preferences.currency === 'USD'
      ? 'USD uses the current SOL rate, not historical exchange rates.'
      : '',
    preferences.volume ? `Volume is recorded wallet ${quoteUnit} flow, including swap fees.` : '',
    trades && !trades.complete ? 'History is partial.' : '',
    storageUnavailable ? 'Chart settings apply to this visit; browser storage is unavailable.' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <section
      aria-label={`${coin.symbol} interactive chart`}
      className={cn('flex min-w-0 flex-col', className)}
    >
      {/* One toolbar row: timeframe on the left, view settings on the right */}
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-neutral-850 px-2">
        <div
          role="group"
          aria-label="Chart interval"
          className="no-scrollbar flex min-w-0 items-center overflow-x-auto"
        >
          {CHART_INTERVALS.map((interval) => (
            <button
              type="button"
              key={interval}
              aria-pressed={preferences.interval === interval}
              onClick={() => update('interval', interval)}
              className={cn(
                'h-7 shrink-0 rounded-md px-2 font-mono text-[11px] font-medium transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary',
                preferences.interval === interval
                  ? 'bg-neutral-850 text-foreground'
                  : 'text-neutral-500 hover:text-neutral-200'
              )}
            >
              {intervalLabel(interval)}
            </button>
          ))}
        </div>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Segmented
            label="Chart metric"
            value={preferences.metric}
            onChange={(value) => update('metric', value)}
            options={[
              ['marketCap', 'MCap'],
              ['price', 'Price'],
            ]}
          />
          <Segmented
            label="Chart currency"
            value={preferences.currency}
            onChange={(value) => update('currency', value)}
            options={[
              ['SOL', quoteUnit],
              ['USD', 'USD'],
            ]}
          />
          <Segmented
            label="Chart style"
            className="hidden sm:flex"
            value={preferences.style}
            onChange={(value) => update('style', value)}
            options={[
              ['candles', <CandleIcon key="candles" />, 'Candles'],
              [
                'line',
                <span key="line" className="iconify h-3.5 w-3.5 ph--chart-line-bold" />,
                'Line',
              ],
            ]}
          />
          <div className="hidden h-7 items-center rounded-md bg-neutral-900 p-0.5 md:flex">
            <Toggle
              label="Volume"
              pressed={preferences.volume}
              onClick={() => update('volume', !preferences.volume)}
            >
              Vol
            </Toggle>
            <Toggle
              label="Logarithmic scale"
              pressed={preferences.logarithmic}
              onClick={() => update('logarithmic', !preferences.logarithmic)}
            >
              Log
            </Toggle>
          </div>
        </div>
      </div>

      <div
        className="group relative min-h-[220px] flex-1"
        role="img"
        aria-label={`${preferences.style === 'candles' ? 'Candlestick' : 'Line'} chart. Drag to pan, scroll or pinch to zoom. ${bars.length} recorded intervals.`}
      >
        <div ref={host} className="absolute inset-0" />

        {/* Legend, TradingView style: sits on the plot, never takes a row of its own */}
        <div
          aria-live="off"
          className="pointer-events-none absolute left-3 top-2.5 z-10 flex max-w-[calc(100%-5rem)] flex-wrap items-center gap-x-2.5 gap-y-0.5 font-mono text-[11px] tabular-nums text-neutral-500"
        >
          <span className="hidden font-sans font-semibold text-neutral-300 sm:inline">
            ${coin.symbol}
            <span className="font-normal text-neutral-500">
              {' '}
              · {preferences.metric === 'marketCap' ? 'MCap' : 'Price'} ·{' '}
              {intervalLabel(preferences.interval)} · {chartCurrency}
            </span>
          </span>
          {coin.isDemo && (
            <span className="rounded bg-primary/10 px-1.5 font-sans text-[10px] font-semibold text-primary">
              Sample
            </span>
          )}
          {active && (
            <span className="flex flex-wrap gap-x-2.5">
              <span>
                O <span className="text-neutral-200">{legend(active.open)}</span>
              </span>
              <span>
                H <span className="text-neutral-200">{legend(active.high)}</span>
              </span>
              <span>
                L <span className="text-neutral-200">{legend(active.low)}</span>
              </span>
              <span>
                C{' '}
                <span className={active.close >= active.open ? 'text-emerald' : 'text-rose'}>
                  {legend(active.close)}
                </span>
              </span>
              {change !== null && (
                <span className={change >= 0 ? 'text-emerald' : 'text-rose'}>
                  {change >= 0 ? '+' : ''}
                  {change.toFixed(2)}%
                </span>
              )}
              {preferences.volume && activeBar && (
                <span>
                  Vol{' '}
                  <span className="text-neutral-200">
                    {formatValue(activeBar.volumeSol / quoteToSol)}
                  </span>
                </span>
              )}
            </span>
          )}
        </div>

        {/* View controls float over the plot and show on hover or keyboard focus */}
        <div className="absolute bottom-9 left-1/2 z-10 hidden -translate-x-1/2 items-center gap-0.5 rounded-lg border border-neutral-800 bg-neutral-950/90 p-0.5 opacity-100 shadow-lg backdrop-blur transition-opacity sm:flex focus-within:opacity-100 has-hover:opacity-0 has-hover:group-hover:opacity-100">
          <ChartButton label="Zoom out chart" icon="ph--minus-bold" onClick={() => zoom(1.4)} />
          <ChartButton label="Zoom in chart" icon="ph--plus-bold" onClick={() => zoom(0.7)} />
          <ChartButton
            label="Fit all history"
            icon="ph--arrows-in-line-horizontal-bold"
            onClick={() => chart.current?.timeScale().fitContent()}
          />
        </div>
        {!following && candles.length > 0 && (
          <button
            type="button"
            onClick={live}
            className="absolute bottom-9 right-16 z-10 inline-flex h-7 items-center gap-1 rounded-md border border-primary/30 bg-neutral-950/90 px-2 text-[11px] font-medium text-primary backdrop-blur hover:bg-primary/10"
          >
            Live <span className="iconify h-3 w-3 ph--arrow-line-right-bold" />
          </button>
        )}

        {(chartError || (!trades && dataError) || noValues || !bars.length) && (
          <div
            className="absolute inset-0 z-20 flex items-center justify-center bg-neutral-950/70 px-5 text-center backdrop-blur-[1px]"
            role="status"
          >
            <div className="max-w-xs text-xs leading-relaxed text-neutral-400">
              {loading && !chartError && !dataError && !noValues ? (
                <span className="iconify mx-auto mb-2 block h-5 w-5 animate-spin text-primary ph--circle-notch-bold" />
              ) : (
                <span className="iconify mx-auto mb-2 block h-6 w-6 text-neutral-600 ph--chart-line-up" />
              )}
              {chartError
                ? 'Chart could not load. Refresh the page to try again.'
                : !trades && dataError
                  ? 'Market history could not load.'
                  : noValues
                    ? preferences.currency === 'USD' && (!solPrice || usdError)
                      ? `USD conversion unavailable. Select ${quoteUnit} to view recorded prices.`
                      : 'Verified token supply is unavailable. Select token price to view this market.'
                    : loading
                      ? 'Loading recorded trades...'
                      : 'No recorded trades yet. The first swap will draw the first candle.'}
              {!trades && dataError && onRetry && (
                <button
                  type="button"
                  onClick={onRetry}
                  className="mx-auto mt-3 block rounded-md bg-neutral-850 px-3 py-1.5 text-[11px] text-neutral-200 hover:bg-neutral-800"
                >
                  Retry market history
                </button>
              )}
            </div>
          </div>
        )}
      </div>

      <div className="flex h-7 shrink-0 items-center gap-3 border-t border-neutral-850 px-3 text-[10px] text-neutral-500">
        {delayed && (
          <span className="truncate text-amber" role="status">
            Updates delayed. Showing the last available trades.
            {onRetry && (
              <button type="button" className="ml-2 underline" onClick={onRetry}>
                Retry
              </button>
            )}
          </span>
        )}
        {trades?.pendingCount ? (
          <span className="truncate" role="status">
            Waiting for {trades.pendingCount} recent transaction
            {trades.pendingCount === 1 ? '' : 's'} to become readable.
          </span>
        ) : delayed ? null : (
          <span className="truncate">
            {bars.length} {intervalLabel(preferences.interval)} intervals with swaps
          </span>
        )}
        <span
          className="ml-auto inline-flex shrink-0 cursor-help items-center gap-1"
          title={methodology}
        >
          <span className="iconify h-3 w-3 ph--info" />
          <span className="sr-only">{methodology}</span>
          <span className="hidden sm:inline">How this chart works</span>
        </span>
        <a
          href="https://www.tradingview.com/"
          target="_blank"
          rel="noreferrer"
          className="shrink-0 hover:text-neutral-300"
        >
          Charts by TradingView
        </a>
      </div>
    </section>
  );
};

function Segmented<T extends string>({
  label,
  value,
  options,
  onChange,
  className,
}: {
  label: string;
  value: T;
  options: [T, React.ReactNode, string?][];
  onChange: (value: T) => void;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={label}
      className={cn('flex h-7 items-center rounded-md bg-neutral-900 p-0.5', className)}
    >
      {options.map(([option, content, title]) => (
        <button
          key={option}
          type="button"
          aria-pressed={value === option}
          aria-label={title}
          title={title}
          onClick={() => onChange(option)}
          className={cn(
            'grid h-6 min-w-6 place-items-center rounded px-1.5 text-[11px] font-medium transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary',
            value === option
              ? 'bg-neutral-750 text-foreground shadow-sm'
              : 'text-neutral-500 hover:text-neutral-200'
          )}
        >
          {content}
        </button>
      ))}
    </div>
  );
}

const Toggle = ({
  label,
  pressed,
  onClick,
  children,
}: React.PropsWithChildren<{ label: string; pressed: boolean; onClick: () => void }>) => (
  <button
    type="button"
    aria-pressed={pressed}
    title={label}
    onClick={onClick}
    className={cn(
      'h-6 rounded px-1.5 text-[11px] font-medium transition-colors focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary',
      pressed ? 'text-primary' : 'text-neutral-500 hover:text-neutral-200'
    )}
  >
    {children}
  </button>
);

const ChartButton = ({
  label,
  icon,
  onClick,
}: {
  label: string;
  icon: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    aria-label={label}
    title={label}
    onClick={onClick}
    className="grid h-7 w-7 place-items-center rounded-md text-neutral-400 transition-colors hover:bg-neutral-850 hover:text-foreground focus-visible:outline focus-visible:outline-1 focus-visible:outline-primary"
  >
    <span className={cn('iconify h-3.5 w-3.5', icon)} />
  </button>
);

const CandleIcon = () => (
  <svg viewBox="0 0 14 14" className="h-3.5 w-3.5" fill="currentColor" aria-hidden>
    <rect x="2" y="4" width="3" height="6" rx="0.5" />
    <rect x="3.25" y="1.5" width="0.5" height="11" />
    <rect x="9" y="3" width="3" height="5" rx="0.5" />
    <rect x="10.25" y="1" width="0.5" height="10" />
  </svg>
);
