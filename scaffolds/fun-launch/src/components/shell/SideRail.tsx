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
        'sticky top-0 z-20 hidden h-screen shrink-0 flex-col border-r border-white/[0.08] bg-panel transition-[width] duration-200 ease-out md:flex',
        expanded ? 'w-[212px]' : 'w-[64px]'
      )}
      aria-label="Sidebar"
    >
      <div
        className={cn(
          'flex h-14 items-center',
          expanded ? 'justify-between px-3' : 'justify-center'
        )}
      >
        <Link
          href="/"
          aria-label={`${BRAND.name} home`}
          className="group flex items-center gap-2 rounded-lg p-1"
        >
          <LogoMark
            small
            className="h-8 w-7 transition-transform duration-300 group-hover:scale-105"
          />
          {expanded && <Wordmark className="text-[16px]" />}
        </Link>
        {expanded && <CollapseButton expanded onClick={() => setExpanded(false)} />}
      </div>

      <div className={cn('px-3 pb-2', !expanded && 'flex justify-center px-0')}>
        <RailTip label="Launch a coin" show={!expanded}>
          <Link
            href="/launch"
            className={cn(
              'btn-holo flex h-10 items-center justify-center gap-2 rounded-lg text-[13px]',
              expanded ? 'w-full text-sm' : 'w-10'
            )}
            aria-label="Launch a coin"
          >
            <span className="iconify h-5 w-5 ph--plus-bold" />
            {expanded && 'Launch'}
          </Link>
        </RailTip>
      </div>

      <nav
        aria-label="Main"
        className={cn('mt-2 flex flex-col gap-0.5', expanded ? 'px-3' : 'items-center')}
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
                  'relative flex h-10 items-center gap-3 rounded-lg text-sm transition-colors',
                  expanded ? 'w-full px-3' : 'w-10 justify-center',
                  active
                    ? 'bg-neutral-900 text-foreground'
                    : 'text-neutral-500 hover:bg-neutral-900/60 hover:text-neutral-100'
                )}
              >
                {active && (
                  <span
                    className="bg-holo absolute -left-3 top-2.5 h-5 w-[2px] rounded-full"
                    aria-hidden
                  />
                )}
                <span
                  className={cn(
                    'iconify h-5 w-5 shrink-0',
                    active ? `${item.activeIcon} text-primary` : item.icon
                  )}
                />
                {expanded && (
                  <span className="flex-1 text-[13px] font-medium">{item.label}</span>
                )}
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
              'flex h-10 items-center gap-3 rounded-lg text-sm transition-colors hover:bg-neutral-900/60',
              privacy.enabled ? 'text-acid' : 'text-neutral-500 hover:text-neutral-100',
              expanded ? 'w-full px-3' : 'w-10 justify-center'
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
              'flex h-10 items-center gap-3 rounded-lg text-sm text-neutral-500 transition-colors hover:bg-neutral-900/60 hover:text-neutral-100',
              expanded ? 'w-full px-3' : 'w-10 justify-center'
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
    className="flex h-8 w-8 items-center justify-center rounded-md text-neutral-500 transition-colors hover:bg-neutral-900 hover:text-neutral-100"
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
          className="z-50 rounded-md border border-neutral-800 bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-neutral-100 shadow-lg data-[state=delayed-open]:animate-in data-[state=delayed-open]:fade-in-0"
        >
          {label}
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
};
