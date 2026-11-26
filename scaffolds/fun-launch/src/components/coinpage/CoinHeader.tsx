import { useMemo, useState } from 'react';
import type { Coin, HoldersResponse, TradesResponse } from '@/lib/coin';
import { explorerUrl } from '@/constants/network';
import { formatReadableNumber } from '@/lib/format/number';
import { summarizeMarket } from '@/lib/market';
import { useSolPrice, useUsd } from '@/hooks/useUsd';
import { cn, shortenAddress } from '@/lib/utils';
import { CoinAvatar } from '../coin/CoinAvatar';
import { BondFill, HOT_BOND_PROGRESS } from '../coin/BondingBar';
import { StarButton } from '../coin/StarButton';
import { AnimatedNumber } from '../ui/AnimatedNumber';
import { ShareButton } from '../coin/ShareButton';
import { SocialLinks } from '../coin/SocialLinks';
import { ProfileEditorButton } from '../profiles/ProfileEditor';
import { formatValue } from './PriceChart';
import { quoteAsset } from '@/lib/feeModes';

type CoinHeaderProps = {
  coin: Coin;
  trades?: TradesResponse;
  holders?: HoldersResponse;
  /** Live-data status, rendered beside the actions */
  status?: React.ReactNode;
  /** Rendered at the right edge, e.g. a close button */
  actions?: React.ReactNode;
};

/** Identity on the left, the numbers traders scan first in one strip, actions on the right. */
export const CoinHeader = ({ coin, trades, holders, status, actions }: CoinHeaderProps) => {
  const [copied, setCopied] = useState(false);
  const { usd } = useUsd();
  const { data: solPrice } = useSolPrice();
  const market = useMemo(
    () =>
      trades ? summarizeMarket(trades.trades, coin.marketCapSol, !trades.complete) : undefined,
    [trades, coin.marketCapSol]
  );
  const change = market?.changePercent ?? null;
  const buyShare = market?.trades ? market.buys / market.trades : null;
  const bonding = coin.isMigrated ? 1 : Math.min(Math.max(coin.progress, 0), 1);

  return (
    <header className="border-b border-neutral-850">
      <div className="flex min-h-16 items-center gap-3 px-4 py-2.5">
        <CoinAvatar
          image={coin.image}
          symbol={coin.symbol}
          className="h-11 w-11 shrink-0 rounded-xl text-lg"
        />
        <div className="min-w-0 flex-1 lg:flex-none">
          <div className="flex items-center gap-2">
            <h2 className="min-w-0 truncate text-base font-semibold leading-tight">{coin.name}</h2>
            <span className="min-w-0 shrink-[3] truncate font-mono text-xs text-neutral-500">
              ${coin.symbol}
            </span>
            {coin.isDemo ? (
              <Badge tone="primary">Demo · not a token</Badge>
            ) : coin.isMigrated ? (
              <Badge tone="emerald">Bonded</Badge>
            ) : null}
          </div>
          <div className="mt-1 flex items-center gap-1 text-[11px] text-neutral-500">
            {!coin.isDemo && (
              <>
                <button
                  type="button"
                  onClick={() => {
                    navigator.clipboard.writeText(coin.mint);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 1200);
                  }}
                  className="-ml-1 inline-flex h-6 items-center gap-1 rounded-md px-1 font-mono hover:bg-neutral-850 hover:text-neutral-200"
                  aria-label="Copy mint address"
                >
                  {shortenAddress(coin.mint)}
                  <span
                    className={cn(
                      'iconify h-3 w-3',
                      copied ? 'text-emerald ph--check-bold' : 'ph--copy'
                    )}
                  />
                </button>
                <a
                  href={explorerUrl(`token/${coin.mint}`)}
                  target="_blank"
                  rel="noreferrer"
                  aria-label="View on explorer"
                  title="View on explorer"
                  className="grid h-6 w-6 place-items-center rounded-md hover:bg-neutral-850 hover:text-neutral-200"
                >
                  <span className="iconify h-3.5 w-3.5 ph--cube" />
                </a>
              </>
            )}
            <SocialLinks
              socials={coin.socials}
              source={coin.source}
              className="[&_a]:h-6 [&_a]:w-6"
            />
          </div>
        </div>

        {/* Desktop stats sit inline; on smaller screens they move to their own strip below */}
        <Stats
          className="hidden flex-1 justify-end lg:flex"
          coin={coin}
          usd={usd}
          solPrice={solPrice}
          market={market}
          change={change}
          buyShare={buyShare}
          bonding={bonding}
          holders={holders}
        />

        <div className="flex shrink-0 items-center gap-0.5 lg:ml-2 lg:border-l lg:border-neutral-850 lg:pl-3">
          {status}
          {!coin.isDemo && <ShareButton mint={coin.mint} symbol={coin.symbol} />}
          {!coin.isDemo && <ProfileEditorButton compact />}
          <StarButton mint={coin.mint} className="h-9 w-9" />
          {actions}
        </div>
      </div>
      <Stats
        className="no-scrollbar overflow-x-auto border-t border-neutral-850 px-4 py-2 lg:hidden"
        coin={coin}
        usd={usd}
        solPrice={solPrice}
        market={market}
        change={change}
        buyShare={buyShare}
        bonding={bonding}
        holders={holders}
      />
    </header>
  );
};

function Stats({
  coin,
  usd,
  solPrice,
  market,
  change,
  buyShare,
  bonding,
  holders,
  className,
}: {
  coin: Coin;
  usd: (sol: number) => string;
  solPrice?: number;
  market?: ReturnType<typeof summarizeMarket>;
  change: number | null;
  buyShare: number | null;
  bonding: number;
  holders?: HoldersResponse;
  className?: string;
}) {
  const quoteUnit = quoteAsset(coin.quoteMint).symbol;
  const quotePrice = coin.priceSol / (coin.quoteToSol ?? 1);
  return (
    <dl className={cn('flex items-center gap-6', className)}>
      <Stat label="Market cap" title={`${formatReadableNumber(coin.marketCapSol)} SOL`}>
        <span className="text-[15px] font-semibold text-foreground">
          <AnimatedNumber value={coin.marketCapSol} format={usd} />
        </span>
        {change !== null && (
          <span className={cn('ml-1.5 text-[11px]', change >= 0 ? 'text-emerald' : 'text-rose')}>
            {change >= 0 ? '+' : ''}
            {change.toFixed(1)}%
          </span>
        )}
      </Stat>
      <Stat label="Price" title={`${quotePrice} ${quoteUnit}`}>
        {solPrice && quoteUnit === 'SOL'
          ? `$${formatValue(coin.priceSol * solPrice)}`
          : `${formatValue(quotePrice)} ${quoteUnit}`}
      </Stat>
      <Stat label={coin.isDemo ? 'Sample vol' : '24h vol'}>
        {market ? usd(market.volumeSol) : '—'}
      </Stat>
      <Stat label="Txns">
        <span>{market ? market.trades : '—'}</span>
        {buyShare !== null && (
          <span
            className="ml-2 inline-flex h-1 w-10 overflow-hidden rounded-full bg-rose/70 align-middle"
            title={`${market?.buys} buys · ${market?.sells} sells`}
            aria-label={`${market?.buys} buys, ${market?.sells} sells`}
          >
            <span className="bg-emerald" style={{ width: `${buyShare * 100}%` }} />
          </span>
        )}
      </Stat>
      <Stat label="Holders">{holders ? holders.holders.length : '—'}</Stat>
      {!coin.isMigrated && (
        <Stat label="Bonding">
          <span className="inline-flex items-center gap-2">
            <span className={cn(bonding >= HOT_BOND_PROGRESS && 'font-semibold text-acid')}>
              {(bonding * 100).toFixed(bonding < 0.1 ? 2 : 1)}%
            </span>
            <span
              className={cn(
                'inline-block h-1.5 w-16 overflow-hidden rounded-full bg-neutral-850',
                bonding >= HOT_BOND_PROGRESS && 'bond-track-hot'
              )}
            >
              <BondFill progress={bonding} />
            </span>
          </span>
        </Stat>
      )}
    </dl>
  );
}

const Stat = ({
  label,
  title,
  children,
}: React.PropsWithChildren<{ label: string; title?: string }>) => (
  <div className="shrink-0" title={title}>
    <dt className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">{label}</dt>
    <dd className="mt-0.5 whitespace-nowrap font-mono text-[13px] font-medium tabular-nums text-neutral-200">
      {children}
    </dd>
  </div>
);

const Badge = ({ tone, children }: React.PropsWithChildren<{ tone: 'primary' | 'emerald' }>) => (
  <span
    className={cn(
      'shrink-0 rounded px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider',
      tone === 'primary' ? 'bg-primary/10 text-primary' : 'bg-holo text-ink'
    )}
  >
    {children}
  </span>
);
