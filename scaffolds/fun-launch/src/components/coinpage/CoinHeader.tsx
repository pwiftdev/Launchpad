import { useState } from 'react';
import type { Coin } from '@/lib/coin';
import { explorerUrl } from '@/constants/network';
import { formatReadableNumber } from '@/lib/format/number';
import { useUsd } from '@/hooks/useUsd';
import { shortenAddress } from '@/lib/utils';
import { CoinAvatar } from '../coin/CoinAvatar';
import { MskdV1Badge } from '../coin/MskdV1Badge';
import { StarButton } from '../coin/StarButton';
import { ShareButton } from '../coin/ShareButton';
import { SocialLinks } from '../coin/SocialLinks';
import { quoteAsset } from '@/lib/feeModes';

export function CoinHeader({ coin, actions }: { coin: Coin; actions?: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  const { usd } = useUsd();
  const quoteUnit = quoteAsset(coin.quoteMint).symbol;
  const price = coin.priceSol / (coin.quoteToSol ?? 1);

  return (
    <header className="enter px-4 pb-4 pt-4 sm:px-5 sm:pt-5">
      <div className="flex items-center gap-3.5">
        <CoinAvatar
          image={coin.image}
          symbol={coin.symbol}
          className="h-14 w-14 shrink-0 rounded-2xl text-xl shadow-[0_14px_30px_-12px_rgba(0,0,0,0.95)]"
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="min-w-0 truncate text-[20px] font-semibold tracking-[-0.03em]">
              {coin.name}
            </h2>
            <span className="truncate font-mono text-[13px] text-neutral-400">${coin.symbol}</span>
            <MskdV1Badge coin={coin} />
            {coin.isDemo && (
              <span className="chip border-primary/25 bg-primary/10 text-primary">Sample</span>
            )}
          </div>
          <div className="mt-0.5 flex items-center gap-1 text-[11.5px] text-neutral-400">
            {!coin.isDemo && (
              <>
                <button
                  type="button"
                  onClick={() =>
                    void navigator.clipboard.writeText(coin.mint).then(
                      () => setCopied(true),
                      () => setCopied(false)
                    )
                  }
                  className="mr-1 inline-flex h-6 items-center gap-1 rounded-full px-1.5 font-mono transition-colors hover:bg-white/[0.06] hover:text-primary"
                  aria-label="Copy mint address"
                  title={coin.mint}
                >
                  {copied ? 'Copied' : shortenAddress(coin.mint)}
                </button>
                <a
                  href={explorerUrl(`token/${coin.mint}`)}
                  target="_blank"
                  rel="noreferrer"
                  className="rounded-full px-1.5 py-0.5 transition-colors hover:bg-white/[0.06] hover:text-primary"
                >
                  Explorer ↗
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
        <div className="flex shrink-0 items-center gap-1">
          {!coin.isDemo && <ShareButton mint={coin.mint} symbol={coin.symbol} />}
          <StarButton mint={coin.mint} className="h-9 w-9" />
          {actions}
        </div>
      </div>
      <dl className="mt-4 grid grid-cols-3 gap-2 text-sm">
        <Stat label="Price">
          <span className="whitespace-nowrap">{formatReadableNumber(price)}</span>{' '}
          <span className="inline-block text-[10px] text-neutral-400 sm:text-xs">{quoteUnit}</span>
        </Stat>
        <Stat label="Market cap">{usd(coin.marketCapSol)}</Stat>
        <Stat label="Bonding">
          {coin.isMigrated
            ? 'Bonded'
            : `${(Math.min(Math.max(coin.progress, 0), 1) * 100).toFixed(1)}%`}
          <span className="mt-2 block h-1.5 overflow-hidden rounded-full bg-black/45 ring-1 ring-inset ring-white/[0.05]">
            <span
              className="bond-fill block h-full"
              style={{
                width: `${coin.isMigrated ? 100 : Math.max(Math.min(coin.progress, 1) * 100, 2)}%`,
              }}
            />
          </span>
        </Stat>
      </dl>
    </header>
  );
}

function Stat({ label, children }: React.PropsWithChildren<{ label: string }>) {
  return (
    <div className="tile min-w-0 px-2 py-2.5 sm:px-3.5">
      <dt className="text-[11px] text-neutral-400">{label}</dt>
      <dd className="mt-1 break-words font-mono text-[11px] font-semibold tracking-tight text-foreground min-[360px]:text-[13px] sm:text-[18px]">
        {children}
      </dd>
    </div>
  );
}
