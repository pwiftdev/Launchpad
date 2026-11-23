import { CoinAvatar } from '@/components/coin/CoinAvatar';
import { CoinLink } from '@/components/coin/CoinLink';
import { BRAND } from '@/constants/brand';

/** Pin the verified first-party mint independently of board sorting and loading. */
export const OfficialToken = () => {
  const mint = BRAND.officialMint;
  if (!mint) return null;
  return (
    <CoinLink
      mint={mint}
      aria-label={`View the official $${BRAND.wordmark.main} token`}
      className="holo-border group mb-3 flex shrink-0 items-center gap-3 rounded-2xl bg-panel p-3 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-primary sm:gap-4 sm:p-4"
    >
      <CoinAvatar
        image={BRAND.assets.token}
        symbol={BRAND.wordmark.main}
        className="h-12 w-12 sm:h-14 sm:w-14"
      />
      <div className="min-w-0 flex-1">
        <div className="mb-1 flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">
          <span aria-hidden="true" className="iconify h-3.5 w-3.5 ph--seal-check-fill" />
          Official token
        </div>
        <p className="font-display text-lg font-bold leading-tight text-foreground sm:text-xl">
          ${BRAND.wordmark.main}{' '}
          <span className="font-sans text-xs font-normal text-neutral-400">{BRAND.name}</span>
        </p>
        <p className="mt-1 hidden truncate font-mono text-[10px] text-neutral-500 sm:block">{mint}</p>
      </div>
      <span className="flex shrink-0 items-center gap-2 text-xs font-semibold text-primary">
        <span className="hidden sm:inline">View token</span>
        <span
          aria-hidden="true"
          className="iconify h-5 w-5 transition-transform group-hover:translate-x-0.5 ph--arrow-right-bold"
        />
      </span>
    </CoinLink>
  );
};
