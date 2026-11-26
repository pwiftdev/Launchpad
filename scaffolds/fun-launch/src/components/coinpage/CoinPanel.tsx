import type { Coin } from '@/lib/coin';
import { useHolders, useTrades } from '@/hooks/useCoins';
import { cn } from '@/lib/utils';
import { CoinHeader } from './CoinHeader';
import { TaxBanner } from './TaxBanner';
import { PotMeter } from './PotMeter';
import { TradeBox } from './TradeBox';
import { PriceChart } from './PriceChart';
import { HoldersPanel } from './HoldersPanel';
import { FairnessCard } from './FairnessCard';
import { RewardsPanel } from './RewardsPanel';
import { TokenCallouts } from '@/components/profiles/TokenCallouts';
import { TokenAbout } from './TokenAbout';
import { MarketConnection } from './MarketConnection';
import { TokenChatRoom } from './TokenChatRoom';

type CoinPanelProps = {
  coin: Coin;
  /** Close button etc. for the header */
  headerActions?: React.ReactNode;
  className?: string;
};

/**
 * Everything for one coin as a single terminal grid: header strip, chart and tape on the left,
 * the order panel and coin facts on the right. Cells share 1px rules instead of nested cards.
 */
export const CoinPanel = ({ coin, headerActions, className }: CoinPanelProps) => {
  const trades = useTrades(coin.mint);
  const holders = useHolders(coin.mint);
  const tax = (!coin.isMigrated || coin.feePolicyVersion === 'bond-v1') && (
    <TaxBanner
      launchedAt={coin.launchedAt}
      isDemo={coin.isDemo}
      feePolicyVersion={coin.feePolicyVersion}
      isMigrated={coin.isMigrated}
      className="border-b border-neutral-850"
    />
  );

  return (
    <div className={cn('flex flex-col bg-neutral-950', className)}>
      {coin.isDemo && (
        <div className="border-b border-primary/20 bg-primary/[0.06] px-4 py-2 text-[11px] text-neutral-400">
          <span className="mr-2 font-semibold text-primary">Sample launch</span>
          Fictional coin, simulated chart and activity. Trading is unavailable.
        </div>
      )}
      <CoinHeader
        coin={coin}
        trades={trades.data}
        holders={holders.data}
        status={<MarketConnection coin={coin} trades={trades} holders={holders} />}
        actions={headerActions}
      />

      <div className="grid flex-1 grid-cols-[minmax(0,1fr)] lg:grid-cols-[minmax(0,1fr)_360px]">
        {/* Market column */}
        <div className="contents lg:flex lg:min-w-0 lg:flex-col lg:border-r lg:border-neutral-850">
          <PriceChart
            coin={coin}
            trades={trades.data}
            isLoading={trades.isLoading}
            error={trades.error}
            onRetry={() => void trades.refetch()}
            className="h-[420px] border-b border-neutral-850 sm:h-[480px] lg:h-[clamp(440px,62vh,680px)]"
          />
          <div className="order-1 border-b border-neutral-850 lg:hidden">
            {tax}
            <TradeBox coin={coin} />
          </div>
          <HoldersPanel
            key={coin.mint}
            coin={coin}
            trades={trades.data}
            holders={holders.data}
            showPotTab={false}
            tradesError={trades.error}
            holdersError={holders.error}
            onRetryTrades={() => void trades.refetch()}
            onRetryHolders={() => void holders.refetch()}
            className="order-3 border-b border-neutral-850 lg:border-b-0"
          />
          {!coin.isDemo && (
            <div className="order-4 border-t border-neutral-850 p-4">
              <TokenCallouts mint={coin.mint} />
            </div>
          )}
        </div>

        {/* Order and facts column */}
        <aside className="contents lg:flex lg:min-w-0 lg:flex-col lg:divide-y lg:divide-neutral-850">
          <div className="hidden lg:block">
            {tax}
            <TradeBox coin={coin} />
          </div>
          {!coin.isDemo && <TokenChatRoom mint={coin.mint} symbol={coin.symbol} />}
          <div className="order-5 min-w-0 divide-y divide-neutral-850">
            <PotMeter coin={coin} pot={trades.data?.pot} />
            <TokenAbout coin={coin} />
            <FairnessCard holders={holders.data} coin={coin} />
            <RewardsPanel coin={coin} />
          </div>
        </aside>
      </div>
    </div>
  );
};
