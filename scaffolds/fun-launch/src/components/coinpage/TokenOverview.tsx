import { useMemo } from 'react';
import type { Coin, HoldersResponse, TradesResponse } from '@/lib/coin';
import { summarizeMarket } from '@/lib/market';
import { useUsd } from '@/hooks/useUsd';

export function TokenOverview({
  coin,
  trades,
  holders,
}: {
  coin: Coin;
  trades?: TradesResponse;
  holders?: HoldersResponse;
}) {
  const { usd } = useUsd();
  const data = useMemo(
    () =>
      trades ? summarizeMarket(trades.trades, coin.marketCapSol, !trades.complete) : undefined,
    [trades, coin.marketCapSol]
  );
  const buyShare = data?.trades ? data.buys / data.trades : 0;
  return (
    <div
      className="grid grid-cols-2 gap-px overflow-hidden rounded-xl border border-neutral-800/70 bg-neutral-800/40 sm:grid-cols-4"
      aria-label={coin.isDemo ? 'Simulated token activity' : 'Recent token activity'}
    >
      <Metric
        label={coin.isDemo ? 'Sample volume' : 'Recent volume'}
        value={data ? usd(data.volumeSol) : '—'}
        note={data?.partial ? 'Partial history' : 'Last 24h of decoded trades'}
      />
      <Metric
        label="Trades"
        value={data ? String(data.trades) : '—'}
        note={data ? `${data.buys} buys · ${data.sells} sells` : 'Loading activity'}
      />
      <Metric
        label="Listed holders"
        value={holders ? String(holders.holders.length) : '—'}
        note="Largest token accounts"
      />
      <div className="bg-neutral-950/95 px-3.5 py-3">
        <span className="text-[10px] text-neutral-400">Buy / sell trades</span>
        <div className="mt-1 flex justify-between font-mono text-xs font-medium">
          <span className="text-emerald">
            {data?.trades ? `${Math.round(buyShare * 100)}%` : '—'}
          </span>
          <span className="text-rose">
            {data?.trades ? `${Math.round((1 - buyShare) * 100)}%` : '—'}
          </span>
        </div>
        <div
          className="mt-2 flex h-1 gap-0.5 overflow-hidden rounded-full bg-neutral-800"
          aria-hidden
        >
          {data?.trades ? (
            <>
              <span className="bg-emerald/70" style={{ width: `${buyShare * 100}%` }} />
              <span className="flex-1 bg-rose/70" />
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <div className="bg-neutral-950/95 px-3.5 py-3">
      <span className="text-[10px] text-neutral-400">{label}</span>
      <p className="mt-1 font-mono text-sm font-semibold tabular">{value}</p>
      <p className="mt-1 truncate text-[9px] text-neutral-500">{note}</p>
    </div>
  );
}
