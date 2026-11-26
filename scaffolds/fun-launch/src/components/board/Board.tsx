import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import type { Coin } from '@/lib/coin';
import { useLocalSetting } from '@/hooks/useLocalSetting';
import { cn } from '@/lib/utils';
import { CoinCard } from './CoinCard';
import { BoardPanel, SortControl } from './BoardPanel';
import { BondHero } from './BondHero';
import { LogoMark } from '../brand/Logo';

type ColumnId = 'new' | 'close' | 'bonded';
type Sort = 'age' | 'mcap' | 'progress';

// "Close to bonding" = a quarter of the way to the migration threshold or more
const CLOSE_TO_BOND_PROGRESS = 0.25;

const SORTERS: Record<Sort, (a: Coin, b: Coin) => number> = {
  age: (a, b) => b.launchedAt - a.launchedAt,
  mcap: (a, b) => b.marketCapSol - a.marketCapSol,
  progress: (a, b) => b.progress - a.progress,
};

const COLUMNS: {
  id: ColumnId;
  title: string;
  /** Mobile tab label */
  short: string;
  subtitle: string;
  icon: string;
  iconClassName: string;
  empty: string;
  filter: (c: Coin) => boolean;
  sorts: [{ id: Sort; label: string }, ...{ id: Sort; label: string }[]];
}[] = [
  {
    id: 'new',
    title: 'New',
    short: 'New',
    subtitle: 'Just dropped',
    icon: 'ph--sparkle-fill',
    iconClassName: 'text-primary',
    empty: 'No launches yet. Mask up and go first.',
    filter: (c) => !c.isMigrated && c.progress < CLOSE_TO_BOND_PROGRESS,
    sorts: [
      { id: 'age', label: 'Newest' },
      { id: 'mcap', label: 'MC' },
    ],
  },
  {
    id: 'close',
    title: 'Bonding',
    short: 'Bonding',
    subtitle: 'Past 25% and climbing',
    icon: 'ph--lightning-fill',
    iconClassName: 'text-acid',
    empty: 'Nothing past 25% yet. Keep pushing.',
    filter: (c) => !c.isMigrated && c.progress >= CLOSE_TO_BOND_PROGRESS,
    sorts: [
      { id: 'progress', label: 'Progress' },
      { id: 'mcap', label: 'MC' },
    ],
  },
  {
    id: 'bonded',
    title: 'Bonded',
    short: 'Bonded',
    subtitle: 'Made it to DAMM v2',
    icon: 'ph--seal-check-fill',
    iconClassName: 'text-cyan',
    empty: 'No coin has bonded yet. Be the first.',
    filter: (c) => c.isMigrated,
    sorts: [
      { id: 'age', label: 'Newest' },
      { id: 'mcap', label: 'MC' },
    ],
  },
];

type BoardProps = {
  coins: Coin[] | undefined;
  status: 'loading' | 'error' | 'success';
  displayStale?: boolean;
};

/** The board: New / Close to bonding / Bonded. Tabs on small screens. */
export const Board = ({ coins, status, displayStale = false }: BoardProps) => {
  const [tab, setTab] = useState<ColumnId>('new');
  const [density, setDensity] = useLocalSetting<'comfortable' | 'compact'>(
    'rinsed.boardDensity',
    'comfortable'
  );
  // Mints present on first load; anything after that animates in as a new launch
  const seen = useRef<Set<string> | null>(null);
  if (coins && !seen.current) seen.current = new Set(coins.map((c) => c.mint));
  const isNew = (mint: string) => !!seen.current && !seen.current.has(mint);
  const [sorts, setSorts] = useLocalSetting<Record<ColumnId, Sort>>('rinsed.sorts', {
    new: 'age',
    close: 'progress',
    bonded: 'age',
  });

  const grouped = useMemo(
    () =>
      Object.fromEntries(
        COLUMNS.map((col) => [
          col.id,
          (coins ?? []).filter(col.filter).sort(SORTERS[sorts[col.id] ?? col.sorts[0].id]),
        ])
      ) as Record<ColumnId, Coin[]>,
    [coins, sorts]
  );

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <BondHero coins={coins} />
      <div className="mb-2.5 flex shrink-0 items-center justify-between gap-3 px-1">
        <div className="flex items-center gap-2">
          <h2 className="font-display text-[14px] uppercase">The board</h2>
          <span className="rounded-md bg-neutral-900 px-1.5 py-0.5 font-mono text-[11px] text-neutral-400">
            {coins?.length ?? '…'} coins
          </span>
          <span className="hidden text-[11px] text-neutral-500 sm:inline">
            Launched by anons. Owned by holders.
          </span>
        </div>
        <div
          role="group"
          aria-label="Card density"
          className="flex shrink-0 gap-0.5 border border-white/[0.09] bg-panel p-1"
        >
          {(['compact', 'comfortable'] as const).map((value) => (
            <button
              key={value}
              type="button"
              aria-pressed={density === value}
              onClick={() => setDensity(value)}
              className={cn(
                'flex items-center gap-1.5 rounded-md px-2 py-1.5 text-[10px] transition-colors',
                density === value
                  ? 'bg-neutral-800 text-foreground shadow-sm'
                  : 'text-neutral-500 hover:text-neutral-200'
              )}
            >
              <span
                className={cn(
                  'iconify h-3.5 w-3.5',
                  value === 'compact' ? 'ph--rows-bold' : 'ph--squares-four-bold'
                )}
              />
              <span className="hidden sm:inline">
                {value === 'compact' ? 'Compact' : 'Comfortable'}
              </span>
              <span className="sr-only sm:hidden">{value}</span>
            </button>
          ))}
        </div>
      </div>
      {displayStale && (
        <p
          role="status"
          className="mb-2 shrink-0 rounded-lg border border-amber-400/15 bg-amber-400/5 px-3 py-2 text-[11px] text-amber-200"
        >
          Live updates are delayed. Showing the last available data while we reconnect.
        </p>
      )}
      <div
        role="tablist"
        aria-label="Board"
        className="mb-2 flex gap-1 border border-white/[0.09] bg-panel p-1 lg:hidden"
      >
        {COLUMNS.map((col) => (
          <button
            key={col.id}
            role="tab"
            aria-selected={tab === col.id}
            onClick={() => setTab(col.id)}
            className={cn(
              'flex-1 rounded-lg py-1.5 text-xs font-semibold transition-colors',
              tab === col.id
                ? 'bg-neutral-850 text-foreground shadow-[inset_0_-2px_0_rgb(var(--primary))]'
                : 'text-neutral-500 hover:text-neutral-200'
            )}
          >
            {col.short}
            {coins && (
              <span className="ml-1 font-mono text-neutral-500">{grouped[col.id].length}</span>
            )}
          </button>
        ))}
      </div>

      <div className="grid min-h-0 flex-1 gap-2 md:gap-3 lg:grid-cols-3">
        {COLUMNS.map((col) => (
          <BoardPanel
            key={col.id}
            id={col.id}
            index={COLUMNS.findIndex((c) => c.id === col.id) + 1}
            title={col.title}
            subtitle={col.subtitle}
            icon={col.icon}
            iconClassName={col.iconClassName}
            count={coins ? grouped[col.id].length : undefined}
            className={cn('max-lg:min-h-[60vh]', tab !== col.id && 'max-lg:hidden')}
            controls={
              <SortControl
                label={`Sort ${col.title}`}
                value={sorts[col.id] ?? col.sorts[0].id}
                options={col.sorts}
                onChange={(v) => setSorts({ ...sorts, [col.id]: v })}
              />
            }
          >
            {status === 'loading' && !coins ? (
              Array.from({ length: 7 }, (_, i) => (
                <div
                  key={i}
                  className="flex items-center gap-3 border-b border-neutral-900 px-3.5 py-4"
                >
                  <div className="h-14 w-14 animate-pulse rounded-xl bg-neutral-900" />
                  <div className="flex-1 space-y-2">
                    <div className="h-3 w-1/3 animate-pulse rounded bg-neutral-900" />
                    <div className="h-2.5 w-1/2 animate-pulse rounded bg-neutral-900" />
                  </div>
                </div>
              ))
            ) : status === 'error' && !coins ? (
              <p className="p-6 text-center text-xs text-rose">
                Couldn’t reach the chain. Retrying…
              </p>
            ) : grouped[col.id].length ? (
              grouped[col.id].map((coin) => (
                <CoinCard
                  key={coin.mint}
                  coin={coin}
                  isNew={isNew(coin.mint)}
                  compact={density === 'compact'}
                />
              ))
            ) : (
              <EmptyColumn text={col.empty} launch={col.id === 'new'} />
            )}
          </BoardPanel>
        ))}
      </div>
    </div>
  );
};

const EmptyColumn = ({ text, launch }: { text: string; launch: boolean }) => (
  <div className="flex flex-col items-center gap-3 px-6 py-14 text-center">
    <LogoMark small animated className="h-14 w-14 opacity-60 grayscale-[0.4]" />
    <p className="max-w-[16rem] text-xs leading-relaxed text-neutral-500">{text}</p>
    {launch && (
      <Link
        href="/launch"
        className="btn-holo mt-1 inline-flex h-8 items-center gap-1.5 rounded-lg px-3 font-display text-[11px] font-bold"
      >
        <span className="iconify h-3.5 w-3.5 ph--plus-bold" />
        Launch the first one
      </Link>
    )}
  </div>
);
