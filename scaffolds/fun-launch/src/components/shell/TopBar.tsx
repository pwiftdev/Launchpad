import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import { cn } from '@/lib/utils';
import { useWalletProfiles } from '@/hooks/useWalletProfiles';
import { ProfileEditorButton } from '../profiles/ProfileEditor';
import { WalletIdentity } from '../profiles/WalletIdentity';
import { useLocalSetting } from '@/hooks/useLocalSetting';
import { LogoMark, NetworkBadge, Wordmark } from '../brand/Logo';
import { usePalette } from './paletteContext';
import { BRAND } from '@/constants/brand';

export const TopBar = () => {
  const { setOpen } = usePalette();
  const { setShowModal } = useUnifiedWalletContext();
  const { disconnect, publicKey } = useWallet();
  const address = useMemo(() => publicKey?.toBase58(), [publicKey]);
  const { profiles } = useWalletProfiles(address ? [address] : []);
  const [isMac, setIsMac] = useState(false);
  const [railExpanded] = useLocalSetting('rinsed.rail', false);
  useEffect(() => setIsMac(/Mac|iPhone|iPad/.test(navigator.userAgent)), []);

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-3 border-b border-white/[0.08] bg-panel px-3 md:px-4">
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
        className="group flex h-9 min-w-9 max-w-md flex-1 items-center gap-2.5 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2.5 text-sm text-neutral-500 transition-colors hover:border-neutral-700 hover:text-neutral-300 sm:px-3"
        aria-label="Search coins"
      >
        <span className="iconify h-4 w-4 shrink-0 ph--magnifying-glass" />
        <span className="min-w-0 flex-1 truncate text-left text-[13px] sm:hidden">Search</span>
        <span className="hidden min-w-0 flex-1 truncate text-left text-[13px] sm:inline">
          Search coins, tickers, mints
        </span>
        <kbd
          className="hidden rounded border border-neutral-800 px-1.5 font-mono text-[10px] text-neutral-500 sm:inline"
          suppressHydrationWarning
        >
          {isMac ? '⌘K' : 'Ctrl K'}
        </kbd>
      </button>

      <div className="ml-auto flex shrink-0 items-center gap-2">
        <span
          className="hidden items-center gap-1.5 rounded-md px-2 py-1 font-term text-[10px] uppercase tracking-[0.12em] text-neutral-500 lg:flex"
          title="No KYC, no account, no email. Your wallet is your only login."
        >
          <span className="h-1.5 w-1.5 rounded-full bg-signal" />
          No KYC
        </span>
        <NetworkBadge className="hidden sm:inline" />
        {address && <ProfileEditorButton compact />}
        {address ? (
          <button
            type="button"
            onClick={() => disconnect()}
            title="Disconnect"
            className="flex h-9 min-w-0 items-center gap-2 rounded-lg border border-white/[0.08] bg-white/[0.03] px-2 text-sm transition-colors hover:border-neutral-700 sm:px-3"
          >
            <span className="h-2 w-2 rounded-full bg-emerald" />
            <span className="max-w-24 text-xs sm:max-w-40">
              <WalletIdentity wallet={address} profile={profiles[address]} compact />
            </span>
          </button>
        ) : (
          <button
            type="button"
            onClick={() => setShowModal(true)}
            className="btn-holo flex h-9 items-center gap-2 rounded-lg px-4 text-[13px]"
          >
            <span className="iconify h-4 w-4 ph--wallet" />
            Connect
          </button>
        )}
      </div>
    </header>
  );
};
