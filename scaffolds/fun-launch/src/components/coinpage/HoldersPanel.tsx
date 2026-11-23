import { useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { useWallet } from '@jup-ag/wallet-adapter';
import type { Coin, HoldersResponse, Trade, TradesResponse } from '@/lib/coin';
import { explorerUrl } from '@/constants/network';
import { BASE_FEE_PERCENT } from '@/constants/launch';
import { formatReadableNumber } from '@/lib/format/number';
import { formatAge } from '@/lib/format/date';
import { displayShare, holderSupplyShare, rankTraders } from '@/lib/tokenActivity';
import { useNow } from '@/hooks/useNow';
import { useUsd } from '@/hooks/useUsd';
import { useWalletProfiles } from '@/hooks/useWalletProfiles';
import { WalletIdentity } from '@/components/profiles/WalletIdentity';
import { cn } from '@/lib/utils';
import { FairnessCard } from './FairnessCard';
import { PotMeter } from './PotMeter';

type Tab = 'trades' | 'holders' | 'traders' | 'pot';
type CoinTabsProps = {
  coin: Coin;
  trades: TradesResponse | undefined;
  holders: HoldersResponse | undefined;
  showPotTab?: boolean;
  tradesError?: unknown;
  holdersError?: unknown;
  onRetryTrades?: () => void;
  onRetryHolders?: () => void;
  className?: string;
};
const td = 'h-11 whitespace-nowrap px-2 font-mono text-xs tabular-nums';

/** Pause freezes only the tape; chart and ownership keep updating. */
export const HoldersPanel = ({
  coin,
  trades,
  holders,
  showPotTab = true,
  tradesError,
  holdersError,
  onRetryTrades,
  onRetryHolders,
  className,
}: CoinTabsProps) => {
  const id = useId();
  const [tab, setTab] = useState<Tab>('trades');
  const [side, setSide] = useState<'all' | 'buy' | 'sell' | 'mine'>('all');
  const [search, setSearch] = useState('');
  const [paused, setPaused] = useState(false);
  const [frozen, setFrozen] = useState<TradesResponse>();
  const { publicKey } = useWallet();
  const wallet = publicKey?.toBase58();
  const wallets = useMemo(
    () => [
      ...new Set([
        ...(trades?.trades.map((trade) => trade.wallet) ?? []),
        ...(holders?.holders.map((holder) => holder.owner) ?? []),
        coin.creator,
      ]),
    ],
    [trades, holders, coin.creator]
  );
  const { profiles } = useWalletProfiles(coin.isDemo ? [] : wallets);
  const tape = paused ? frozen : trades;
  const identity = (address: string) => (
    <a
      href={coin.isDemo ? undefined : explorerUrl(`address/${address}`)}
      target="_blank"
      rel="noreferrer"
      className="text-neutral-300 hover:text-primary"
    >
      <WalletIdentity wallet={address} profile={profiles[address]} compact />
    </a>
  );
  const match = (address: string) =>
    !search ||
    address.toLowerCase().includes(search.toLowerCase()) ||
    profiles[address]?.username?.toLowerCase().includes(search.toLowerCase());
  const shownTrades = (tape?.trades ?? []).filter(
    (trade) =>
      match(trade.wallet) &&
      (side === 'all' || (side === 'mine' ? trade.wallet === wallet : trade.side === side))
  );
  const shownHolders = (holders?.holders ?? []).filter((holder) => match(holder.owner));
  const traders = useMemo(() => rankTraders(trades?.trades ?? []), [trades]);
  const tabs: [Tab, string, number | undefined][] = [
    ['trades', 'Trades', trades?.trades.length],
    ['holders', 'Holders', holders?.holders.length],
    ['traders', 'Traders', trades ? traders.length : undefined],
    ...(showPotTab ? [['pot', 'Rewards', undefined] as [Tab, string, undefined]] : []),
  ];
  const data = tab === 'holders' ? holders : trades;
  const error = tab === 'holders' ? holdersError : tradesError;
  const retry = tab === 'holders' ? onRetryHolders : onRetryTrades;
  return (
    <section aria-label="Coin activity" className={cn('min-w-0', className)}>
      {/* Tabs and filters share one toolbar row; it wraps only on narrow screens */}
      <div className="flex min-h-10 flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-neutral-850 px-2 py-1.5 sm:py-0">
        <div
          role="tablist"
          aria-label="Token activity"
          className="no-scrollbar flex min-w-0 items-center gap-0.5 overflow-x-auto"
        >
          {tabs.map(([key, label, count]) => (
            <button
              key={key}
              type="button"
              role="tab"
              id={`${id}-${key}`}
              aria-controls={`${id}-panel`}
              aria-selected={tab === key}
              onClick={() => setTab(key)}
              className={cn(
                'inline-flex h-7 shrink-0 items-center rounded-md px-2.5 text-xs transition-colors',
                tab === key
                  ? 'bg-neutral-850 font-semibold text-foreground'
                  : 'text-neutral-500 hover:text-neutral-100'
              )}
            >
              {label}
              {count !== undefined && (
                <span className="ml-1.5 font-mono text-[10px] text-neutral-500">{count}</span>
              )}
            </button>
          ))}
        </div>
        {tab !== 'pot' && (
          <div className="flex w-full min-w-0 items-center gap-1.5 sm:ml-auto sm:w-auto">
            <label className="relative min-w-0 flex-1 sm:w-48 sm:flex-none">
              <span className="sr-only">Find a wallet or username</span>
              <span className="iconify absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-neutral-500 ph--magnifying-glass" />
              <input
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                maxLength={64}
                placeholder="Wallet or username"
                className="h-7 w-full min-w-24 rounded-md bg-neutral-900 pl-7 pr-2 text-[11px] outline-none ring-primary/40 placeholder:text-neutral-600 focus:ring-1"
              />
            </label>
            {tab === 'trades' && (
              <>
                <select
                  aria-label="Trade filter"
                  value={side}
                  onChange={(event) => setSide(event.target.value as typeof side)}
                  className="h-7 rounded-md bg-neutral-900 px-2 text-[11px] text-neutral-300 outline-none ring-primary/40 focus:ring-1"
                >
                  <option value="all">All trades</option>
                  <option value="buy">Buys</option>
                  <option value="sell">Sells</option>
                  {wallet && <option value="mine">My trades</option>}
                </select>
                <button
                  type="button"
                  aria-pressed={paused}
                  aria-label={paused ? 'Resume' : 'Pause'}
                  title={paused ? 'Resume the live tape' : 'Pause the live tape'}
                  onClick={() => {
                    if (!paused) setFrozen(trades);
                    setPaused(!paused);
                  }}
                  className={cn(
                    'grid h-7 w-7 shrink-0 place-items-center rounded-md bg-neutral-900 transition-colors',
                    paused ? 'text-amber' : 'text-neutral-400 hover:text-neutral-100'
                  )}
                >
                  <span
                    className={cn(
                      'iconify h-3.5 w-3.5',
                      paused ? 'ph--play-fill' : 'ph--pause-fill'
                    )}
                  />
                </button>
              </>
            )}
          </div>
        )}
      </div>
      <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${tab}`}>
        {tab !== 'pot' && error != null && (
          <div
            role="status"
            className="flex items-center justify-between gap-3 border-b border-amber/15 bg-amber/5 px-3 py-2 text-[11px] text-amber"
          >
            <span>
              {data
                ? 'Connection interrupted. Showing the last loaded data.'
                : `Could not load ${tab}.`}
            </span>
            <button
              type="button"
              onClick={retry}
              className="shrink-0 font-semibold underline underline-offset-2"
            >
              Retry
            </button>
          </div>
        )}
        {tab !== 'pot' && !data ? (
          error == null ? (
            <div aria-busy="true" aria-label={`Loading ${tab}`} className="space-y-3 p-4">
              {[0, 1, 2, 3].map((key) => (
                <div key={key} className="h-6 animate-pulse rounded bg-neutral-850/70" />
              ))}
            </div>
          ) : (
            <Empty
              title="Waiting for data"
              note="Retry when your connection is available. Other panels can still be used."
            />
          )
        ) : tab === 'trades' ? (
          <TradeRows coin={coin} rows={shownTrades} identity={identity} />
        ) : tab === 'holders' ? (
          <>
            <VirtualTable
              rows={shownHolders}
              rowKey={(holder) => holder.owner}
              headings={['#', 'Holder', 'Tokens', '% of total supply']}
              render={(holder, index) => (
                <>
                  <td className={cn(td, 'w-10 text-neutral-500')}>{index + 1}</td>
                  <td className={td}>
                    <div className="flex items-center gap-1.5">
                      {identity(holder.owner)}
                      {holder.isCreator && <DevBadge />}
                      {holder.owner === wallet && (
                        <span className="text-[9px] text-primary">YOU</span>
                      )}
                    </div>
                  </td>
                  <td className={cn(td, 'text-right text-neutral-300')}>
                    {formatReadableNumber(holder.amount)}
                  </td>
                  <td className={cn(td, 'text-right text-primary')}>
                    <div className="flex items-center justify-end gap-2">
                      <span className="hidden h-1 w-10 overflow-hidden rounded bg-neutral-800 sm:block">
                        <span
                          className="block h-full rounded bg-primary/60"
                          style={{
                            width: `${(holderSupplyShare(holder, holders?.tokenSupply ?? coin.tokenSupply) ?? 0) * 100}%`,
                          }}
                        />
                      </span>
                      {displayShare(
                        holderSupplyShare(holder, holders?.tokenSupply ?? coin.tokenSupply)
                      )}
                    </div>
                  </td>
                </>
              )}
              empty={
                <Empty
                  title={search ? 'No matching holders' : 'No holders outside the pool yet'}
                  note={
                    search
                      ? 'Try another wallet or username.'
                      : 'Balances appear after tokens leave the liquidity pool.'
                  }
                />
              }
            />
            <p className="border-t border-neutral-850 px-3 py-2 text-[10px] leading-relaxed text-neutral-500">
              Shares use the current total token supply, including tokens in liquidity pools. Pool
              and custody accounts are excluded from this list.
              {holders?.partial !== false
                ? ' Largest accounts only; a wallet may hold additional accounts.'
                : ''}
            </p>
          </>
        ) : tab === 'traders' ? (
          <>
            <VirtualTable
              rows={traders.filter((trader) => match(trader.wallet))}
              rowKey={(trader) => trader.wallet}
              headings={['Trader', 'Bought', 'Sold', 'Trades']}
              render={(trader) => (
                <>
                  <td className={td}>{identity(trader.wallet)}</td>
                  <td className={cn(td, 'text-right text-emerald')}>
                    {formatReadableNumber(trader.boughtSol)} SOL
                  </td>
                  <td className={cn(td, 'text-right text-rose')}>
                    {formatReadableNumber(trader.soldSol)} SOL
                  </td>
                  <td className={cn(td, 'text-right text-neutral-400')}>
                    <span className="text-emerald">{trader.buys}</span> /{' '}
                    <span className="text-rose">{trader.sells}</span>
                  </td>
                </>
              )}
              empty={
                <Empty
                  title="No matching traders"
                  note="Traders appear as verified swaps are loaded."
                />
              }
            />
            <p className="border-t border-neutral-850 px-3 py-2 text-[10px] text-neutral-500">
              Ranked by volume in the loaded trade history. Bought and sold show SOL cash flow,
              including trading fees on buys.
            </p>
          </>
        ) : tab === 'pot' ? (
          <div className="grid gap-6 p-4 md:grid-cols-2">
            <PotMeter coin={coin} pot={trades?.pot} />
            <FairnessCard holders={holders} coin={coin} />
          </div>
        ) : null}
      </div>
      {tab === 'trades' && tape && (
        <div className="flex items-center justify-between gap-3 border-t border-neutral-850 px-3 py-2 text-[10px] text-neutral-500">
          <span>
            {paused ? 'Tape paused · chart stays live' : 'Confirmed on-chain swaps'}
            {!tape.complete ? ' · Recent history' : ''}
          </span>
          <span className="font-mono">{shownTrades.length} shown</span>
        </div>
      )}
    </section>
  );
};

function DevBadge() {
  return (
    <span className="rounded bg-amber/10 px-1 py-0.5 font-sans text-[9px] font-semibold text-amber">
      DEV
    </span>
  );
}
function Empty({ title, note }: { title: string; note: string }) {
  return (
    <div className="flex min-h-36 flex-col items-center justify-center gap-1.5 px-5 py-8 text-center">
      <span className="iconify mb-1 h-5 w-5 text-neutral-600 ph--rows" />
      <p className="text-xs font-medium text-neutral-300">{title}</p>
      <p className="max-w-xs text-[11px] text-neutral-500">{note}</p>
    </div>
  );
}
function TradeRows({
  coin,
  rows,
  identity,
}: {
  coin: Coin;
  rows: Trade[];
  identity: (wallet: string) => ReactNode;
}) {
  const now = useNow(1000, coin.isDemo);
  const { usd } = useUsd();
  return (
    <VirtualTable
      rows={rows}
      rowKey={(trade) =>
        trade.id ?? `${trade.sig}:${trade.instructionIndex ?? 0}:${trade.eventIndex ?? 0}`
      }
      headings={['Age', 'Side', 'Value', 'Tokens', 'Fee', 'Trader']}
      empty={
        <Empty
          title="No matching trades"
          note="The next confirmed swap appears here automatically. Try another filter if trades are hidden."
        />
      }
      render={(trade) => {
        const base = trade.side === 'buy' ? trade.sol : trade.sol + trade.feeSol;
        const fee = base > 0 ? (trade.feeSol / base) * 100 : 0;
        const taxed = trade.route !== 'damm-v2' && fee > BASE_FEE_PERCENT + 0.05;
        return (
          <>
            <td className={cn(td, 'text-neutral-500')}>
              <a
                href={coin.isDemo ? undefined : explorerUrl(`tx/${trade.sig}`)}
                target="_blank"
                rel="noreferrer"
                title={new Date(trade.ts * 1000).toLocaleString()}
                className="hover:text-primary"
                suppressHydrationWarning
              >
                {now ? formatAge(new Date(trade.ts * 1000), new Date(now * 1000)) : '—'}
              </a>
            </td>
            <td className={cn(td, trade.side === 'buy' ? 'text-emerald' : 'text-rose')}>
              <span
                className={cn(
                  'inline-flex items-center gap-1 rounded px-1.5 py-1 text-[10px] font-semibold',
                  trade.side === 'buy' ? 'bg-emerald/10' : 'bg-rose/10'
                )}
              >
                <span
                  className={cn(
                    'iconify h-3 w-3',
                    trade.side === 'buy' ? 'ph--arrow-up-right' : 'ph--arrow-down-right'
                  )}
                />
                {trade.side === 'buy' ? 'Buy' : 'Sell'}
              </span>
            </td>
            <td className={cn(td, 'text-right text-neutral-200')} title={`${trade.sol} SOL`}>
              {usd(trade.sol)}
            </td>
            <td className={cn(td, 'text-right text-neutral-400')}>
              {formatReadableNumber(trade.tokens)}
            </td>
            <td
              className={cn(td, 'text-right', taxed ? 'text-rose' : 'text-neutral-500')}
              title={
                trade.feeSolIsEstimate
                  ? 'Fee charged in tokens; SOL equivalent estimated at the trade price.'
                  : 'Executed trading fee'
              }
            >
              {trade.feeSolIsEstimate ? '~' : ''}
              {fee.toFixed(fee < 10 ? 2 : 0)}%
            </td>
            <td className={td}>
              <div className="flex items-center gap-1">
                {identity(trade.wallet)}
                {trade.wallet === coin.creator && <DevBadge />}
              </div>
            </td>
          </>
        );
      }}
    />
  );
}

/** Only visible rows mount, avoiding hundreds of wallet cells on every update. */
function VirtualTable<T>({
  rows,
  rowKey,
  headings,
  render,
  empty,
}: {
  rows: T[];
  rowKey: (row: T) => string;
  headings: string[];
  render: (row: T, index: number) => ReactNode;
  empty: ReactNode;
}) {
  const viewport = useRef<HTMLDivElement>(null);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => viewport.current,
    estimateSize: () => 44,
    overscan: 6,
    getItemKey: (index) => rowKey(rows[index]!),
  });
  const items = virtual.getVirtualItems();
  const top = items[0]?.start ?? 0;
  const bottom = items.length ? virtual.getTotalSize() - items[items.length - 1]!.end : 0;
  if (!rows.length) return <>{empty}</>;
  return (
    <div
      ref={viewport}
      className="max-h-[380px] overflow-auto overscroll-contain"
      style={{ overflowAnchor: 'none' }}
    >
      <table className={cn('w-full', headings.length > 4 ? 'min-w-[590px]' : 'min-w-[420px]')}>
        <thead className="sticky top-0 z-10 bg-neutral-950">
          <tr>
            {headings.map((heading) => (
              <th
                key={heading}
                scope="col"
                className={cn(
                  'whitespace-nowrap px-2 py-2.5 text-[10px] font-medium text-neutral-500',
                  ['#', 'Holder', 'Trader', 'Age', 'Side'].includes(heading)
                    ? 'text-left'
                    : 'text-right'
                )}
              >
                {heading}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {top > 0 && (
            <tr aria-hidden="true">
              <td colSpan={headings.length} style={{ height: top, padding: 0, border: 0 }} />
            </tr>
          )}
          {items.map((item) => (
            <tr
              key={item.key}
              className="border-t border-neutral-850/70 transition-colors hover:bg-neutral-900/60"
            >
              {render(rows[item.index]!, item.index)}
            </tr>
          ))}
          {bottom > 0 && (
            <tr aria-hidden="true">
              <td colSpan={headings.length} style={{ height: bottom, padding: 0, border: 0 }} />
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
