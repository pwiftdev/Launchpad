import { useUnifiedWalletContext, useWallet } from '@jup-ag/wallet-adapter';
import Link from 'next/link';
import { useRouter } from 'next/router';
import { Button } from './ui/button';
import { CreatePoolButton } from './CreatePoolButton';
import { ThemeToggle } from './ThemeToggle';
import { HeaderSearch } from './HeaderSearch';
import { useMemo } from 'react';
import { cn, shortenAddress } from '@/lib/utils';
import { LogoMark, NetworkBadge, Wordmark } from './brand/Logo';
import { ProfileEditorButton } from './profiles/ProfileEditor';

export const NAV_LINKS = [
  { href: '/', label: 'Board' },
  { href: '/rules', label: 'Rules' },
  { href: '/burns', label: 'Burns' },
] as const;

export const Header = () => {
  const { setShowModal } = useUnifiedWalletContext();
  const { pathname } = useRouter();
  const { disconnect, publicKey } = useWallet();
  const address = useMemo(() => publicKey?.toBase58(), [publicKey]);

  return (
    <header className="sticky top-0 z-30 w-full border-b border-neutral-850 bg-background/85 backdrop-blur-md">
      <div className="flex h-14 w-full items-center gap-4 px-4">
        <Link
          href="/"
          aria-label="MSKD.fun home"
          className="group flex shrink-0 items-center gap-2 rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/60"
        >
          <LogoMark className="h-7 w-8 transition-transform group-hover:-rotate-6" />
          <Wordmark className="hidden text-base sm:inline" />
          <NetworkBadge className="hidden md:inline" />
        </Link>

        <nav aria-label="Main" className="hidden items-center gap-0.5 md:flex">
          {NAV_LINKS.map(({ href, label }) => (
            <NavLink key={href} href={href} active={pathname === href}>
              {label}
            </NavLink>
          ))}
        </nav>

        <HeaderSearch className="ml-auto hidden w-full max-w-xs lg:block" />

        <div className="ml-auto flex items-center gap-2 lg:ml-0">
          <CreatePoolButton />
          {address && <ProfileEditorButton />}
          {address ? (
            <Button variant="secondary" onClick={() => disconnect()} title="Disconnect">
              <span className="font-mono text-xs">{shortenAddress(address)}</span>
            </Button>
          ) : (
            <Button variant="secondary" onClick={() => setShowModal(true)}>
              Connect
            </Button>
          )}
          <ThemeToggle />
        </div>
      </div>

      {/* Mobile nav */}
      <nav
        aria-label="Main"
        className="flex items-center gap-0.5 overflow-x-auto border-t border-neutral-850 px-3 py-1 scrollbar-none md:hidden"
      >
        {NAV_LINKS.map(({ href, label }) => (
          <NavLink key={href} href={href} active={pathname === href}>
            {label}
          </NavLink>
        ))}
        <NetworkBadge className="ml-auto" />
      </nav>
    </header>
  );
};

const NavLink = ({
  href,
  active,
  children,
}: React.PropsWithChildren<{ href: string; active: boolean }>) => (
  <Link
    href={href}
    aria-current={active ? 'page' : undefined}
    className={cn(
      'rounded-md px-3 py-1.5 text-sm transition-colors',
      active ? 'text-foreground' : 'text-neutral-500 hover:text-neutral-100'
    )}
  >
    {children}
  </Link>
);

export default Header;
