import { BRAND } from '@/constants/brand';
import { NETWORK } from '@/constants/network';
import { cn } from '@/lib/utils';

type LogoMarkProps = {
  className?: string;
  /** Gentle float with an occasional glitch, for heroes and empty states */
  animated?: boolean;
  /** Faint accent glow behind the mask */
  halo?: boolean;
  /** Use the 128px files (rails, badges, toasts) */
  small?: boolean;
  /** Always the white mask, for surfaces that stay black in light mode */
  forceWhite?: boolean;
};

/** The ski mask. White on dark, black on light. */
export const LogoMark = ({ className, animated, halo, small, forceWhite }: LogoMarkProps) => {
  const size = small ? 128 : 512;
  const imgClass = cn(
    'select-none object-contain',
    animated && 'mark-float',
    halo ? 'relative h-full w-full' : 'h-full w-full'
  );
  const pair = (
    <>
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={small ? BRAND.assets.markSmall : BRAND.logo}
        width={size}
        height={size}
        alt=""
        aria-hidden
        draggable={false}
        className={cn('mk-white', imgClass)}
      />
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={small ? BRAND.assets.markBlackSmall : BRAND.assets.markBlack}
        width={size}
        height={size}
        alt=""
        aria-hidden
        draggable={false}
        loading="lazy"
        className={cn('mk-black', imgClass)}
      />
    </>
  );
  return (
    <span
      className={cn('brand-mark relative inline-block shrink-0', forceWhite && 'mk-force-white', className)}
      aria-hidden
    >
      {halo && <span className="mark-halo" />}
      {pair}
    </span>
  );
};

type WordmarkProps = {
  className?: string;
  /** Kept for older call sites; the supplied wordmark already includes ".fun" */
  tld?: boolean;
  /** Always the white wordmark */
  forceWhite?: boolean;
};

/** MSKD.fun wordmark; sized by font-size (1em tall). */
export const Wordmark = ({ className, forceWhite }: WordmarkProps) => (
  <span
    className={cn(
      'brand-wordmark inline-flex min-w-0 max-w-full items-end align-middle leading-none',
      forceWhite && 'wm-force-white',
      className
    )}
  >
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img
      src={BRAND.wordmarkImage}
      width={1792}
      height={356}
      alt={BRAND.name}
      draggable={false}
      className="wm-white block h-[1em] w-auto max-w-full select-none object-contain"
    />
    {/* eslint-disable-next-line @next/next/no-img-element */}
    <img
      src={BRAND.assets.wordmarkBlack}
      width={1792}
      height={356}
      alt=""
      aria-hidden
      draggable={false}
      loading="lazy"
      className="wm-black h-[1em] w-auto max-w-full select-none object-contain"
    />
  </span>
);

export const NetworkBadge = ({ className }: { className?: string }) => {
  if (NETWORK === 'mainnet-beta') return null;
  return (
    <span
      className={cn(
        'border border-amber/50 bg-amber/10 px-2 py-0.5 font-term text-2xs font-semibold uppercase tracking-wider text-amber',
        className
      )}
    >
      {NETWORK === 'localnet' ? 'Localnet' : 'Devnet'}
    </span>
  );
};
