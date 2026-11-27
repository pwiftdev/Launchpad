import Link from 'next/link';
import { useMemo, useRef, useState } from 'react';
import type { Coin } from '@/lib/coin';
import { useLocalSetting } from '@/hooks/useLocalSetting';
import { cn } from '@/lib/utils';
import { CoinCard } from './CoinCard';
import { BoardPanel, SortControl } from './BoardPanel';
import { BoardOverview } from './BoardOverview';
import { LogoMark } from '../brand/Logo';
import { Segmented } from '../ui/Segmented';

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
    iconClassName: 'text-primary-200',
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
    iconClassName: 'text-emerald',
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
      <BoardOverview coins={coins} />
      <div className="mb-3 flex shrink-0 items-center justify-between gap-3 px-1">
        <div className="flex min-w-0 items-baseline gap-2.5">
          <h2 className="text-[20px] font-semibold tracking-[-0.03em]">The board</h2>
          <span className="rounded-full bg-white/[0.06] px-2 py-0.5 font-mono text-[11px] text-neutral-300 ring-1 ring-inset ring-white/[0.08]">
            {coins?.length ?? '…'} coins
          </span>
          <span className="hidden truncate text-[12px] text-neutral-500 sm:inline">
            Launched by anons. Owned by holders.
          </span>
        </div>
        <Segmented
          label="Card density"
          value={density}
          onChange={setDensity}
          options={[
            {
              id: 'compact',
              icon: 'ph--rows-bold',
              ariaLabel: 'Compact',
              label: <span className="hidden sm:inline">Compact</span>,
            },
            {
              id: 'comfortable',
              icon: 'ph--squares-four-bold',
              ariaLabel: 'Comfortable',
              label: <span className="hidden sm:inline">Comfortable</span>,
            },
          ]}
        />
      </div>
      {displayStale && (
        <p
          role="status"
          className="mb-3 flex shrink-0 items-center gap-2 rounded-2xl border border-amber/20 bg-amber/[0.06] px-3.5 py-2.5 text-[12px] text-amber-200 backdrop-blur-xl"
        >
          <span aria-hidden className="iconify h-4 w-4 shrink-0 text-amber ph--cloud-warning" />
          Live updates are delayed. Showing the last available data while we reconnect.
        </p>
      )}
      <Segmented
        role="tablist"
        label="Board"
        value={tab}
        onChange={setTab}
        stretch
        size="md"
        className="mb-3 lg:hidden"
        options={COLUMNS.map((col) => ({
          id: col.id,
          label: (
            <>
              {col.short}
              {coins && (
                <span className="font-mono text-[11px] text-neutral-500">
                  {grouped[col.id].length}
                </span>
              )}
            </>
          ),
        }))}
      />

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-3">
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
                  className="flex items-center gap-3.5 px-2.5 py-3"
                  style={{ opacity: 1 - i * 0.11 }}
                >
                  <div className="skeleton h-[60px] w-[60px] rounded-2xl" />
                  <div className="flex-1 space-y-2">
                    <div className="skeleton h-3.5 w-1/3" />
                    <div className="skeleton h-2.5 w-1/2" />
                  </div>
                  <div className="space-y-2">
                    <div className="skeleton ml-auto h-3.5 w-16" />
                    <div className="skeleton ml-auto h-2.5 w-10" />
                  </div>
                </div>
              ))
            ) : status === 'error' && !coins ? (
              <p className="flex items-center justify-center gap-2 p-8 text-center text-xs text-rose">
                <span aria-hidden className="iconify h-4 w-4 animate-pulse ph--wifi-slash" />
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
  <div className="flex flex-col items-center gap-3 px-6 py-16 text-center">
    <span className="relative grid h-20 w-20 place-items-center">
      <span
        aria-hidden
        className="absolute inset-0 rounded-full bg-[radial-gradient(circle,rgba(255,102,0,0.25),transparent_70%)] blur-md"
      />
      <LogoMark small animated className="relative h-14 w-14 opacity-80" />
    </span>
    <p className="max-w-[16rem] text-[12.5px] leading-relaxed text-neutral-400">{text}</p>
    {launch && (
      <Link
        href="/launch"
        className="btn-holo mt-1 inline-flex h-9 items-center gap-1.5 px-4 text-[12.5px]"
      >
        <span className="iconify h-3.5 w-3.5 ph--plus-bold" />
        Launch the first one
      </Link>
    )}
  </div>
);
