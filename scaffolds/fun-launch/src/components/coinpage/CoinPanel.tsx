import type { Coin } from '@/lib/coin';
import { useCoinPrices } from '@/hooks/useCoins';
import { cn } from '@/lib/utils';
import { CoinHeader } from './CoinHeader';
import { TaxBanner } from './TaxBanner';
import { FeeSplit } from '@/components/fees/FeeSplit';
import { LAUNCH_FEE_MODE, feeMode } from '@/lib/feeModes';
import { TradeBox } from './TradeBox';
import { PriceChart } from './PriceChart';
import { HoldersPanel } from './HoldersPanel';
import { RewardsPanel } from './RewardsPanel';
import { TokenAbout } from './TokenAbout';

export function CoinPanel({
  coin,
  headerActions,
  className,
}: {
  coin: Coin;
  headerActions?: React.ReactNode;
  className?: string;
}) {
  const prices = useCoinPrices(coin.mint);
  return (
    <div className={cn('flex flex-col', className)}>
      <CoinHeader key={coin.mint} coin={coin} actions={headerActions} />
      <div className="grid flex-1 grid-cols-[minmax(0,1fr)] gap-3 px-3 pb-3 sm:px-4 sm:pb-4 lg:grid-cols-[minmax(0,1fr)_348px]">
        <aside className="enter enter-1 min-w-0 lg:col-start-2 lg:row-start-1">
          <div className="surface overflow-hidden rounded-3xl lg:sticky lg:top-4">
            {(!coin.isMigrated || coin.feePolicyVersion === 'bond-v1') && (
              <TaxBanner
                launchedAt={coin.launchedAt}
                isDemo={coin.isDemo}
                feePolicyVersion={coin.feePolicyVersion}
                isMigrated={coin.isMigrated}
                className="border-b border-white/[0.06]"
              />
            )}
            <TradeBox key={coin.mint} coin={coin} />
          </div>
        </aside>
        <div className="enter flex min-w-0 flex-col gap-3 lg:col-start-1 lg:row-start-1">
          <PriceChart
            key={`chart-${coin.mint}`}
            history={prices.data}
            isLoading={prices.isLoading}
            error={prices.error}
            onRetry={() => void prices.refetch()}
          />
          <HoldersPanel key={`holders-${coin.mint}`} coin={coin} />
          {coin.creatorShareBps != null && (
            <section aria-label="Fee split" className="surface rounded-3xl p-4 sm:p-5">
              <h3 className="text-[15px] font-semibold tracking-tight">Fee split</h3>
              <FeeSplit
                mode={feeMode(LAUNCH_FEE_MODE)}
                creatorShareBps={coin.creatorShareBps}
                compact
                className="mt-2"
              />
            </section>
          )}
          <TokenAbout coin={coin} />
          <RewardsPanel coin={coin} />
        </div>
      </div>
    </div>
  );
}
