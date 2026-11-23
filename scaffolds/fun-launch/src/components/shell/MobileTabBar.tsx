import Link from 'next/link';
import { useRouter } from 'next/router';
import { NAV_ITEMS, isActivePath } from '@/constants/nav';
import { cn } from '@/lib/utils';
import { usePalette } from './paletteContext';

/** Bottom tab bar on phones, with the launch button in the middle. */
export const MobileTabBar = () => {
  const { pathname } = useRouter();
  const [first, ...rest] = NAV_ITEMS;
  const { setOpen } = usePalette();

  return (
    <nav
      aria-label="Main"
      className="fixed inset-x-0 bottom-0 z-30 flex h-16 items-center justify-around border-t border-white/[0.08] bg-panel pb-[env(safe-area-inset-bottom)] md:hidden"
    >
      <Tab {...first} active={isActivePath(pathname, first.href)} />
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="flex w-16 flex-col items-center gap-0.5 text-[10px] text-neutral-500"
        aria-label="Search tokens"
      >
        <span className="iconify h-5 w-5 ph--magnifying-glass" />
        Search
      </button>
      <Link
        href="/launch"
        aria-label="Launch a coin"
        className="btn-holo -mt-6 flex h-14 w-14 items-center justify-center rounded-2xl ring-4 ring-background active:scale-95"
      >
        <span className="iconify h-7 w-7 ph--plus-bold" />
      </Link>
      {rest.map((item) => (
        <Tab key={item.href} {...item} active={isActivePath(pathname, item.href)} />
      ))}
    </nav>
  );
};

const Tab = ({
  href,
  label,
  icon,
  activeIcon,
  active,
}: (typeof NAV_ITEMS)[number] & { active: boolean }) => (
  <Link
    href={href}
    aria-current={active ? 'page' : undefined}
    className={cn(
      'flex w-16 flex-col items-center gap-0.5 text-[10px]',
      active ? 'text-foreground' : 'text-neutral-500'
    )}
  >
    <span className={cn('iconify h-5 w-5', active ? `${activeIcon} text-primary` : icon)} />
    {label}
  </Link>
);
