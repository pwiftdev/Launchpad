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
      className="group flex h-10 shrink-0 items-center gap-1.5 rounded-full border border-primary/30 bg-primary/[0.08] pl-1 pr-1 shadow-[inset_0_1px_0_rgba(255,255,255,0.08)] transition-all duration-200 ease-out hover:-translate-y-px hover:border-primary/60 hover:bg-primary/[0.14] hover:shadow-[0_8px_20px_-10px_rgba(255,102,0,0.6)] sm:pr-3"
    >
      <CoinAvatar
        image={BRAND.assets.token}
        symbol={BRAND.ticker}
        className="h-8 w-8 rounded-full text-[11px] ring-0 transition-transform duration-300 ease-spring group-hover:rotate-12"
      />
      <span className="hidden text-[12.5px] font-semibold text-foreground sm:inline">
        ${BRAND.ticker}
      </span>
      <span
        aria-hidden="true"
        className="iconify hidden h-3.5 w-3.5 text-primary ph--seal-check-fill sm:inline"
      />
    </CoinLink>
  );
};
