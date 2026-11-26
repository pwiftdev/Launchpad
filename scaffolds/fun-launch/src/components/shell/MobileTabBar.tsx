import Link from 'next/link';
import { useRouter } from 'next/router';
import { NAV_ITEMS, isActivePath } from '@/constants/nav';
import { cn } from '@/lib/utils';
import { usePalette } from './paletteContext';

const tabClass = 'flex min-w-0 flex-col items-center gap-0.5 py-1 text-[10px]';

export const MobileTabBar = () => {
  const { pathname } = useRouter();
  const { open, setOpen } = usePalette();
  const half = Math.floor(NAV_ITEMS.length / 2);
  const left = NAV_ITEMS.slice(0, half);
  const right = NAV_ITEMS.slice(half);

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 grid h-16 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] place-items-center border-t border-white/[0.08] bg-panel pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <div className="grid w-full grid-flow-col auto-cols-fr">
        {left.map((item) => (
          <Tab key={item.href} {...item} pathname={pathname} />
        ))}
        <button
          type="button"
          aria-haspopup="dialog"
          aria-expanded={open}
          onClick={() => setOpen(true)}
          className={cn(tabClass, open ? 'text-foreground' : 'text-neutral-500')}
        >
          <span
            aria-hidden="true"
            className={cn('iconify h-5 w-5 ph--magnifying-glass', open && 'text-primary')}
          />
          Search
        </button>
      </div>
      <Link
        href="/launch"
        aria-label="Launch a coin"
        className="btn-holo -mt-6 flex h-14 w-14 items-center justify-center rounded-2xl ring-4 ring-background active:scale-95"
      >
        <span className="iconify h-7 w-7 ph--plus-bold" />
      </Link>
      <div className="grid w-full grid-flow-col auto-cols-fr">
        {right.map((item) => (
          <Tab key={item.href} {...item} pathname={pathname} />
        ))}
      </div>
    </nav>
  );
};

const Tab = ({
  href,
  label,
  icon,
  activeIcon,
  pathname,
}: (typeof NAV_ITEMS)[number] & { pathname: string }) => {
  const active = isActivePath(pathname, href);
  return (
    <Link
      href={href}
      aria-current={active ? 'page' : undefined}
      className={cn(tabClass, active ? 'text-foreground' : 'text-neutral-500')}
    >
      <span className={cn('iconify h-5 w-5', active ? `${activeIcon} text-primary` : icon)} />
      {label}
    </Link>
  );
};
