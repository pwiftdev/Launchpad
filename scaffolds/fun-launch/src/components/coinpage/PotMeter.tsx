import Link from 'next/link';
import type { Coin } from '@/lib/coin';
import { useUsd } from '@/hooks/useUsd';
import { BondFill, HOT_BOND_PROGRESS } from '../coin/BondingBar';
import { LogoMark } from '../brand/Logo';
import { explorerUrl, NETWORK_LABEL } from '@/constants/network';
import { formatReadableNumber } from '@/lib/format/number';
import { cn, shortenAddress } from '@/lib/utils';
import { PanelSection } from './PanelSection';
import { quoteAsset } from '@/lib/feeModes';

const MILESTONES = [25, 50, 75];

/** Status line, by progress. */
function mood(pct: number) {
  if (pct >= HOT_BOND_PROGRESS * 100) return 'So close. Push it over.';
  if (pct >= 50) return 'Past halfway. Keep going.';
  if (pct >= 25) return 'Building. Every buy counts.';
  return 'Early days. Plenty of curve left.';
}

export const PotMeter = ({ coin }: { coin: Coin }) => {
  const { usd } = useUsd();
  const pct = Math.min(Math.max(coin.progress * 100, 0), 100);
  const hot = !coin.isMigrated && pct >= HOT_BOND_PROGRESS * 100;
  const remainingSol = Math.max(coin.thresholdSol - coin.quoteReserveSol, 0);
  const { symbol } = quoteAsset(coin.quoteMint);
  const quoteToSol = coin.quoteToSol ?? 1;

  return (
    <PanelSection
      title={coin.isMigrated ? 'Pool' : 'Bond meter'}
      label={coin.isMigrated ? 'Trading pool' : 'Bonding progress'}
      aside={
        coin.isMigrated ? undefined : (
          <span
            className={cn(
              'font-mono text-xs font-semibold tabular-nums',
              hot ? 'text-acid' : 'text-foreground'
            )}
          >
            {pct.toFixed(pct < 10 ? 2 : 1)}%
          </span>
        )
      }
    >
      {coin.isMigrated ? (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-neutral-900/60 px-3 py-2.5">
          <span className="flex min-w-0 items-center gap-2 text-[12px] text-neutral-300">
            <span aria-hidden className="iconify h-4 w-4 shrink-0 text-primary ph--swap" />
            Trading on Meteora DAMM v2
          </span>
          {coin.migratedPool && !coin.isDemo && (
            <a
              href={explorerUrl(`address/${coin.migratedPool}`)}
              target="_blank"
              rel="noreferrer"
              aria-label={`View Meteora pool ${coin.migratedPool} in explorer`}
              className="inline-flex shrink-0 items-center gap-1 font-mono text-[11px] text-primary hover:underline"
            >
              {shortenAddress(coin.migratedPool)}
              <span aria-hidden className="iconify h-3 w-3 ph--arrow-up-right" />
            </a>
          )}
        </div>
      ) : (
        <>
          <div className="relative pr-6">
            <div
              role="progressbar"
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(pct)}
              aria-label="Bonding progress"
              className={cn(
                'relative h-2.5 overflow-hidden rounded-full bg-neutral-850',
                hot && 'bond-track-hot'
              )}
            >
              <BondFill progress={coin.progress} />
              {MILESTONES.map((m) => (
                <span
                  key={m}
                  className="absolute inset-y-0 w-px bg-background/70"
                  style={{ left: `${m}%` }}
                  aria-hidden
                />
              ))}
            </div>
            {/* The goal sits at the end of the track */}
            <LogoMark
              small
              className={cn(
                'absolute -right-1 top-1/2 h-6 w-5 -translate-y-1/2 transition-[filter,opacity]',
                hot ? 'animate-pray' : 'opacity-50 grayscale-[0.6]'
              )}
            />
          </div>
          <div className="mt-2.5 grid grid-cols-2 gap-2">
            <div className="rounded-lg bg-neutral-900/60 px-2.5 py-2">
              <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
                In curve
              </p>
              <p
                className="font-mono text-[13px] font-semibold tabular-nums"
                title={`${(coin.quoteReserveSol / quoteToSol).toFixed(2)} ${symbol} in the curve`}
              >
                {symbol === 'SOL'
                  ? usd(coin.quoteReserveSol)
                  : `${formatReadableNumber(coin.quoteReserveSol / quoteToSol)} ${symbol}`}
              </p>
            </div>
            <div className="rounded-lg bg-neutral-900/60 px-2.5 py-2">
              <p className="text-[9px] font-semibold uppercase tracking-[0.12em] text-neutral-500">
                To bond
              </p>
              <p
                className={cn(
                  'font-mono text-[13px] font-semibold tabular-nums',
                  hot && 'text-acid'
                )}
                title={`${formatReadableNumber(coin.thresholdSol / quoteToSol)} ${symbol} graduation target`}
              >
                {formatReadableNumber(remainingSol / quoteToSol)} {symbol}
              </p>
            </div>
          </div>
          <p
            className={cn(
              'mt-2.5 flex items-center gap-1.5 text-[11px] font-medium',
              hot ? 'text-acid' : 'text-neutral-400'
            )}
          >
            <span className="font-term">&gt;</span>
            {mood(pct)}
          </p>
        </>
      )}
      <p className="mt-3 text-[11px] leading-relaxed text-neutral-500">
        {coin.isDemo
          ? 'Sample activity is illustrative.'
          : coin.mode
            ? `${NETWORK_LABEL} token. Funded rewards appear in the rewards panel; completed buybacks appear in the burn feed.`
            : 'Legacy preview. This token has no verified reward policy.'}{' '}
        <Link href="/rules" className="text-primary hover:underline">
          Launch rules
        </Link>
      </p>
    </PanelSection>
  );
};
