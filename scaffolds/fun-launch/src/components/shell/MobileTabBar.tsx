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
      className="glass-strong fixed inset-x-2 bottom-[max(0.5rem,env(safe-area-inset-bottom))] z-30 grid h-16 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] place-items-center rounded-[26px] md:hidden"
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
          className={cn(tabClass, open ? 'text-foreground' : 'text-neutral-400')}
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
        className="btn-holo -mt-7 flex h-14 w-14 items-center justify-center rounded-[20px] ring-[5px] ring-[rgb(16_13_12)] active:scale-95"
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
      className={cn(
        tabClass,
        'transition-colors duration-200',
        active ? 'text-foreground' : 'text-neutral-400'
      )}
    >
      <span
        className={cn(
          'iconify h-5 w-5 transition-transform duration-200 ease-spring',
          active
            ? `${activeIcon} scale-110 text-primary drop-shadow-[0_0_8px_rgba(255,102,0,0.6)]`
            : icon
        )}
      />
      {label}
    </Link>
  );
};
