import Link from 'next/link';
import { BRAND } from '@/constants/brand';
import { LogoMark, Wordmark } from './brand/Logo';
import { NAV_LINKS } from './Header';

export const Footer = () => (
  <footer className="border-t border-neutral-850">
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-4 py-8 md:flex-row md:items-center md:justify-between">
      <div className="flex items-center gap-3">
        <LogoMark className="h-8 w-9" />
        <div>
          <Wordmark className="text-base" />
          <p className="mt-1 text-xs text-neutral-500">
            {BRAND.headline.top} {BRAND.headline.bottom}
          </p>
        </div>
      </div>

      <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm">
        {NAV_LINKS.map(({ href, label }) => (
          <Link key={href} href={href} className="text-neutral-400 hover:text-neutral-100">
            {label}
          </Link>
        ))}
        <Link href="/launch" className="text-neutral-400 hover:text-neutral-100">
          Launch
        </Link>
      </nav>

      <p className="text-xs text-neutral-500">Built on Meteora Dynamic Bonding Curve · Solana</p>
    </div>
  </footer>
);
