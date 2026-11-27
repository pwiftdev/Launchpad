import Link from 'next/link';
import { useRouter } from 'next/router';
import { Tooltip } from 'radix-ui';
import { usePrivacyMode } from '@/hooks/usePrivacyMode';
import { NAV_ITEMS, isActivePath } from '@/constants/nav';
import { BRAND } from '@/constants/brand';
import { useLocalSetting } from '@/hooks/useLocalSetting';
import { cn } from '@/lib/utils';
import { LogoMark, Wordmark } from '../brand/Logo';

/** Collapsible left navigation rail (desktop). */
export const SideRail = () => {
  const { pathname } = useRouter();
  const [expanded, setExpanded] = useLocalSetting('rinsed.rail', false);
  const privacy = usePrivacyMode();

  return (
    <aside
      className={cn(
        'glass z-20 hidden h-full shrink-0 flex-col rounded-3xl transition-[width] duration-300 ease-out md:flex',
        expanded ? 'w-[220px]' : 'w-[68px]'
      )}
      aria-label="Sidebar"
    >
      <div
        className={cn(
          'flex h-16 items-center',
          expanded ? 'justify-between px-3.5' : 'justify-center'
        )}
      >
        <Link
          href="/"
          aria-label={`${BRAND.name} home`}
          className="group flex items-center gap-2 rounded-xl p-1"
        >
          <LogoMark
            small
            className="h-8 w-7 drop-shadow-[0_6px_14px_rgba(255,102,0,0.35)] transition-transform duration-300 ease-spring group-hover:-rotate-6 group-hover:scale-110"
          />
          {expanded && <Wordmark className="text-[16px]" />}
        </Link>
        {expanded && <CollapseButton expanded onClick={() => setExpanded(false)} />}
      </div>

      <div className={cn('px-3 pb-3', !expanded && 'flex justify-center px-0')}>
        <RailTip label="Launch a coin" show={!expanded}>
          <Link
            href="/launch"
            className={cn(
              'btn-holo group flex h-11 items-center justify-center gap-2 rounded-2xl text-[13px]',
              expanded ? 'w-full text-sm' : 'w-11'
            )}
            aria-label="Launch a coin"
          >
            <span className="iconify h-5 w-5 transition-transform duration-200 ease-spring group-hover:rotate-90 ph--plus-bold" />
            {expanded && 'Launch a coin'}
          </Link>
        </RailTip>
      </div>

      <nav
        aria-label="Main"
        className={cn('mt-1 flex flex-col gap-1', expanded ? 'px-3' : 'items-center')}
      >
        {NAV_ITEMS.map((item) => {
          const active = isActivePath(pathname, item.href);
          return (
            <RailTip key={item.href} label={item.label} show={!expanded}>
              <Link
                href={item.href}
                aria-current={active ? 'page' : undefined}
                aria-label={item.label}
                className={cn(
                  'group relative flex h-11 items-center gap-3 rounded-2xl text-sm transition-all duration-200 ease-out',
                  expanded ? 'w-full px-3' : 'w-11 justify-center',
                  active
                    ? 'bg-gradient-to-b from-white/[0.10] to-white/[0.03] text-foreground shadow-[inset_0_1px_0_rgba(255,255,255,0.10),0_8px_20px_-12px_rgba(0,0,0,0.9)]'
                    : 'text-neutral-400 hover:bg-white/[0.05] hover:text-neutral-100'
                )}
              >
                {active && (
                  <span
                    className="absolute -left-3 top-1/2 h-5 w-1 -translate-y-1/2 rounded-full bg-primary shadow-[0_0_12px_2px_rgba(255,102,0,0.6)]"
                    aria-hidden
                  />
                )}
                <span
                  className={cn(
                    'iconify h-5 w-5 shrink-0 transition-transform duration-200 ease-spring group-hover:scale-110',
                    active
                      ? `${item.activeIcon} text-primary drop-shadow-[0_0_8px_rgba(255,102,0,0.55)]`
                      : item.icon
                  )}
                />
                {expanded && <span className="flex-1 text-[13px] font-medium">{item.label}</span>}
              </Link>
            </RailTip>
          );
        })}
      </nav>

      <div className={cn('mt-auto flex flex-col gap-0.5 pb-3', expanded ? 'px-3' : 'items-center')}>
        <RailTip
          label={privacy.enabled ? 'Privacy mode on (Shift+P)' : 'Privacy mode (Shift+P)'}
          show={!expanded}
        >
          <button
            type="button"
            onClick={privacy.toggle}
            aria-pressed={privacy.enabled}
            aria-label="Privacy mode: blur wallet addresses"
            className={cn(
              'flex h-10 items-center gap-3 rounded-2xl text-sm transition-all duration-200 ease-out hover:bg-white/[0.05]',
              privacy.enabled ? 'text-primary' : 'text-neutral-400 hover:text-neutral-100',
              expanded ? 'w-full px-3' : 'w-11 justify-center'
            )}
          >
            <span
              className={cn(
                'iconify h-5 w-5 shrink-0',
                privacy.enabled ? 'ph--eye-slash-fill' : 'ph--eye-slash'
              )}
            />
            {expanded && <span className="text-[13px] font-medium">Privacy mode</span>}
          </button>
        </RailTip>
        <RailTip label={`${BRAND.xHandle} on X`} show={!expanded}>
          <a
            href={`https://x.com/${BRAND.xHandle.replace('@', '')}`}
            target="_blank"
            rel="noreferrer"
            aria-label={`${BRAND.name} on X`}
            className={cn(
              'flex h-10 items-center gap-3 rounded-2xl text-sm text-neutral-400 transition-all duration-200 ease-out hover:bg-white/[0.05] hover:text-neutral-100',
              expanded ? 'w-full px-3' : 'w-11 justify-center'
            )}
          >
            <span className="iconify h-5 w-5 ph--x-logo" />
            {expanded && BRAND.xHandle}
          </a>
        </RailTip>
        {!expanded && <CollapseButton expanded={false} onClick={() => setExpanded(true)} />}
      </div>
    </aside>
  );
};

const CollapseButton = ({ expanded, onClick }: { expanded: boolean; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
    title={expanded ? 'Collapse sidebar' : 'Expand sidebar'}
    className="flex h-8 w-8 items-center justify-center rounded-xl text-neutral-500 transition-all duration-200 ease-out hover:bg-white/[0.06] hover:text-neutral-100"
  >
    <span
      className={cn(
        'iconify h-4 w-4',
        expanded ? 'ph--caret-double-left' : 'ph--caret-double-right'
      )}
    />
  </button>
);

/** Tooltip to the right of a rail item, only while the rail is collapsed. */
const RailTip = ({
  label,
  show,
  children,
}: React.PropsWithChildren<{ label: string; show: boolean }>) => {
  if (!show) return <>{children}</>;
  return (
    <Tooltip.Root delayDuration={80}>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content
          side="right"
          sideOffset={10}
          className="glass-strong z-50 rounded-xl px-3 py-1.5 text-xs font-medium text-neutral-100 data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0 data-[state=delayed-open]:slide-in-from-left-1 data-[state=delayed-open]:duration-200"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
};
