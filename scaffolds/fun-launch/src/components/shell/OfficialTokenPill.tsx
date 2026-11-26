import { CoinAvatar } from '@/components/coin/CoinAvatar';
import { CoinLink } from '@/components/coin/CoinLink';
import { BRAND } from '@/constants/brand';

export const OfficialTokenPill = () => {
  const mint = BRAND.officialMint;
  if (!mint) return null;
  return (
    <CoinLink
      mint={mint}
      aria-label={`Official $${BRAND.ticker} token`}
      title={`Official $${BRAND.ticker} · ${mint}`}
      className="flex h-9 shrink-0 items-center gap-1.5 border border-primary/30 bg-primary/[0.06] px-1 transition-colors hover:border-primary/70 hover:bg-primary/10 sm:pr-2.5"
    >
      <CoinAvatar
        image={BRAND.assets.token}
        symbol={BRAND.ticker}
        className="h-7 w-7 rounded-none text-[11px] ring-0"
      />
      <span className="hidden font-term text-[11px] font-semibold uppercase tracking-[0.08em] text-foreground sm:inline">
        ${BRAND.ticker}
      </span>
      <span
        aria-hidden="true"
        className="iconify hidden h-3.5 w-3.5 text-primary ph--seal-check-fill sm:inline"
      />
    </CoinLink>
  );
};
