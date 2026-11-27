import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import { cn } from '@/lib/utils';
import { WalletIdentity } from '../profiles/WalletIdentity';
import { useLocalSetting } from '@/hooks/useLocalSetting';
import { LogoMark, NetworkBadge, Wordmark } from '../brand/Logo';
import { usePalette } from './paletteContext';
import { BRAND } from '@/constants/brand';
import { OfficialTokenPill } from './OfficialTokenPill';

export const TopBar = () => {
  const { setOpen } = usePalette();
  const { setShowModal } = useUnifiedWalletContext();
  const { disconnect, publicKey } = useWallet();
  const address = useMemo(() => publicKey?.toBase58(), [publicKey]);
  const [isMac, setIsMac] = useState(false);
  const [railExpanded] = useLocalSetting('rinsed.rail', false);
  useEffect(() => setIsMac(/Mac|iPhone|iPad/.test(navigator.userAgent)), []);

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.08] bg-[rgb(18_15_14/0.72)] px-3 backdrop-blur-2xl md:glass md:h-[60px] md:rounded-2xl md:border md:px-3.5">
      <Link
        href="/"
        aria-label={BRAND.name}
        className={cn('mr-3 hidden shrink-0', !railExpanded && 'lg:block')}
      >
        <Wordmark className="text-[19px]" />
      </Link>
      <Link
        href="/"
        aria-label={`${BRAND.name} home`}
        className="flex items-center gap-1.5 md:hidden"
      >
        <LogoMark small className="h-8 w-7" />
        <Wordmark className="hidden text-[16px] xs:inline-flex" />
      </Link>

      <button
        type="button"
        onClick={() => setOpen(true)}
        className="well group flex h-10 min-w-10 max-w-md flex-1 items-center gap-2.5 rounded-xl px-3 text-sm text-neutral-400 transition-all duration-200 ease-out hover:border-white/15 hover:bg-black/30 hover:text-neutral-200 sm:px-3.5"
        aria-label="Search coins"
      >
        <span className="iconify h-4 w-4 shrink-0 transition-transform duration-200 ease-spring group-hover:scale-110 ph--magnifying-glass" />
        <span className="min-w-0 flex-1 truncate text-left text-[13px] sm:hidden">Search</span>
        <span className="hidden min-w-0 flex-1 truncate text-left text-[13px] sm:inline">
          Search coins, tickers, mints
        </span>
        <kbd
          className="hidden rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-0.5 font-term text-[10px] text-neutral-400 shadow-[inset_0_-1px_0_rgba(0,0,0,0.4)] sm:inline"
          suppressHydrationWarning
        >
          {isMac ? '⌘K' : 'Ctrl K'}
        </kbd>
      </button>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <OfficialTokenPill />
        <NetworkBadge className="hidden sm:inline" />
        {address ? (
          <button
            type="button"
            onClick={() => disconnect()}
            title="Disconnect"
            className="btn-glass group flex h-10 min-w-0 items-center gap-2 px-2.5 text-sm sm:px-3.5"
          >
            <span className="relative flex h-2 w-2">
              <span className="absolute inset-0 animate-ping rounded-full bg-emerald/60" />
              <span className="relative h-2 w-2 rounded-full bg-emerald" />
            </span>
            <span className="max-w-24 text-xs sm:max-w-40">
              <WalletIdentity wallet={address} compact />
            </span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className="btn-holo flex h-10 items-center gap-2 px-4 text-[13.5px]"
          >
            <span className="iconify h-4 w-4 ph--wallet" />
            Connect
          </button>
        )}
      </div>
    </header>
  );
};
