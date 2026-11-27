import { BondingBar } from '@/components/coin/BondingBar';
import { CoinAvatar } from '@/components/coin/CoinAvatar';
import { SocialLinks } from '@/components/coin/SocialLinks';
import { SCHEDULE, pct, type FeeMode } from '@/lib/feeModes';
import type { Socials } from '@/lib/socials';

export const LaunchPreviewCard = ({
  name,
  ticker,
  image,
  socials,
  mode: launchMode,
  creatorShareBps,
  source,
}: {
  name: string;
  ticker: string;
  image: string | null;
  socials?: Socials;
  source?: string;
  mode: FeeMode;
  /** Masked: the creator's share of the 0.60%, in bps of that share. */
  creatorShareBps?: number;
}) => (
  <div className="surface rounded-3xl p-5">
    <p className="eyebrow">Preview on the board</p>
    <div className="tile mt-3 flex gap-3.5 p-3.5">
      <CoinAvatar
        image={image}
        symbol={ticker || 'P'}
        className="h-16 w-16 rounded-2xl text-2xl shadow-[0_12px_26px_-12px_rgba(0,0,0,0.95)]"
      />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[15px] font-semibold tracking-tight">{name || 'Your coin'}</p>
        <p className="truncate font-mono text-xs text-neutral-500">
          ${(ticker || 'TICKER').toUpperCase()}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          <span className="inline-flex items-center gap-1 rounded-full bg-rose/15 px-2 py-0.5 font-mono text-2xs font-bold text-rose">
            <span className="iconify h-3 w-3 ph--crosshair-fill" />
            Launch slot {pct(SCHEDULE.startingFeeBps)}
          </span>
          <span className="chip py-0.5 text-[10px]">{launchMode.label}</span>
          {creatorShareBps !== undefined && (
            <span className="chip py-0.5 text-[10px]">Holders {100 - creatorShareBps / 100}%</span>
          )}
        </div>
        <BondingBar progress={0} className="mt-2 h-1.5" />
      </div>
    </div>
    <SocialLinks socials={socials} source={source} className="mt-2 -ml-1.5" />
  </div>
);
