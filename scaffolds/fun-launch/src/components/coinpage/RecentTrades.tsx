import { explorerUrl } from '@/constants/network';
import { useRecentTrades } from '@/hooks/useCoins';
import type { Coin } from '@/lib/coin';
import { formatReadableNumber } from '@/lib/format/number';

const tradeTime = new Intl.DateTimeFormat('en', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'UTC',
});

export function RecentTrades({ coin }: { coin: Coin }) {
  const { data, isLoading, isError, refetch } = useRecentTrades(coin);
  return (
    <section aria-label="Recent trades" className="surface rounded-3xl p-4 sm:p-5">
      <h3 className="text-[15px] font-semibold tracking-tight">Recent trades</h3>
      {isLoading && <p className="mt-2 text-sm text-neutral-400">Loading trades…</p>}
      {isError && (
        <p className="mt-2 text-sm text-neutral-400">
          Trade updates are unavailable.{' '}
          <button type="button" className="text-primary underline" onClick={() => void refetch()}>
            Retry
          </button>
        </p>
      )}
      {data &&
        (data.trades.length ? (
          <ul className="mt-2 divide-y divide-white/[0.06] text-sm">
            {data.trades.map((trade) => {
              const side = trade.side === 'buy' ? 'Buy' : 'Sell';
              const time = `${tradeTime.format(trade.ts * 1000)} UTC`;
              return (
                <li key={trade.id ?? trade.sig} className="flex items-center gap-3 py-2">
                  <span className={trade.side === 'buy' ? 'text-emerald-400' : 'text-rose-400'}>
                    {side}
                  </span>
                  <span className="font-mono">{formatReadableNumber(trade.sol)} SOL</span>
                  {coin.isDemo ? (
                    <span className="ml-auto text-right text-xs text-neutral-400">{time}</span>
                  ) : (
                    <a
                      href={explorerUrl(`tx/${trade.sig}`)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`View ${side.toLowerCase()} transaction, ${time}`}
                      className="ml-auto text-right text-xs text-neutral-400 underline-offset-2 hover:text-primary hover:underline"
                    >
                      {time}
                    </a>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-neutral-400">
            {data.complete ? 'No trades yet.' : 'Trade history is catching up.'}
          </p>
        ))}
    </section>
  );
}
