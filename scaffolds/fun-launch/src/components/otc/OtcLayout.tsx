import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

/** Plain panel: one dark fill, hairline border, square corners (globals.css `.surface`). */
export const otcPanel = 'surface min-w-0';
/** Primary panel: the same fill with the signal corner brackets used on the board hero. */
export const otcFeature = 'holo-border min-w-0 bg-panel';
export const otcInset = 'border border-neutral-800 bg-neutral-950';
export const otcField =
  'h-11 w-full min-w-0 border border-neutral-800 bg-neutral-950 px-3 text-sm text-foreground transition-colors placeholder:text-neutral-600 hover:border-neutral-700 focus-visible:border-primary focus-visible:outline-none disabled:opacity-60';
/** Section title inside a panel */
export const otcTitle = 'font-display text-lg uppercase leading-tight sm:text-xl';
/** Small field / group label in the terminal face */
export const otcLabel = 'font-term text-[11px] uppercase tracking-[0.12em] text-neutral-400';

const otcSections = ['otc-desk', 'otc-explainer', 'otc-privacy'] as const;
type OtcSection = (typeof otcSections)[number];

export function isOtcSectionHash(hash: string) {
  return otcSections.some((section) => hash === `#${section}`);
}

export function OtcSectionLink({
  section,
  className,
  children,
}: {
  section: OtcSection;
  className?: string;
  children: ReactNode;
}) {
  return (
    <a
      href={`#${section}`}
      className={className}
      onClick={(event) => {
        if (
          event.defaultPrevented ||
          event.metaKey ||
          event.ctrlKey ||
          event.altKey ||
          event.shiftKey
        )
          return;
        const target = document.getElementById(section);
        if (!target) return;
        event.preventDefault();
        target.focus({ preventScroll: true });
        target.scrollIntoView({ block: 'start' });
      }}
    >
      {children}
    </a>
  );
}

export function OtcIcon({ name, className }: { name: `ph--${string}`; className?: string }) {
  return <span aria-hidden="true" className={cn('iconify h-5 w-5 shrink-0', name, className)} />;
}

/** A small live dot, the same signal used for "live" state across the site. */
export function OtcPulse({ className }: { className?: string }) {
  return (
    <span aria-hidden="true" className={cn('relative flex h-1.5 w-1.5 shrink-0', className)}>
      <span className="absolute inset-0 animate-ping rounded-full bg-signal opacity-60" />
      <span className="relative h-1.5 w-1.5 rounded-full bg-signal" />
    </span>
  );
}

/** Panel header: an eyebrow, a display title and an optional line of help. */
export function OtcPanelHead({
  eyebrow,
  title,
  children,
  icon,
}: {
  eyebrow?: string;
  title: string;
  children?: ReactNode;
  icon?: `ph--${string}`;
}) {
  return (
    <div className="flex items-start gap-3">
      {icon && (
        <span className="inline-flex h-10 w-10 shrink-0 items-center justify-center border border-primary/30 bg-primary/10 text-primary">
          <OtcIcon name={icon} className="h-5 w-5" />
        </span>
      )}
      <div className="min-w-0">
        {eyebrow && <p className="eyebrow mb-1.5">{eyebrow}</p>}
        <h2 className={otcTitle}>{title}</h2>
        {children && (
          <p className="mt-1.5 max-w-prose text-sm leading-relaxed text-neutral-400">{children}</p>
        )}
      </div>
    </div>
  );
}

export function OtcGrid({ children, aside }: { children: ReactNode; aside: ReactNode }) {
  return (
    <div className="grid min-w-0 items-start gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(290px,0.5fr)]">
      <div className="min-w-0 space-y-4">{children}</div>
      <div className="min-w-0 space-y-4 lg:sticky lg:top-6">{aside}</div>
    </div>
  );
}

export function OtcFeedback({ error, notice }: { error?: string; notice?: string }) {
  if (!error && !notice) return null;
  return (
    <div
      role={error ? 'alert' : 'status'}
      className={cn(
        'flex items-start gap-2.5 border px-3 py-3 text-sm leading-5',
        error
          ? 'border-rose/30 bg-rose/5 text-neutral-100'
          : 'border-neutral-800 bg-neutral-950 text-neutral-200'
      )}
    >
      <OtcIcon
        name={error ? 'ph--warning-circle' : 'ph--info'}
        className={cn('h-4 w-4 translate-y-0.5', error ? 'text-rose' : 'text-primary')}
      />
      <span className="min-w-0 break-words">{error || notice}</span>
    </div>
  );
}

type Visibility = 'Off-chain' | 'Public' | 'Encrypted';

/** Visibility chip: neutral for off-chain, rose for public, signal for encrypted. */
export function OtcVisibility({ label }: { label: Visibility }) {
  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center gap-1 border px-1.5 py-0.5 font-term text-[10px] uppercase tracking-[0.1em]',
        label === 'Encrypted'
          ? 'border-primary/40 bg-primary/10 text-primary'
          : label === 'Public'
            ? 'border-rose/30 text-rose'
            : 'border-neutral-700 text-neutral-300'
      )}
    >
      <OtcIcon
        name={
          label === 'Encrypted' ? 'ph--lock-simple' : label === 'Public' ? 'ph--eye' : 'ph--link'
        }
        className="h-3 w-3"
      />
      {label}
    </span>
  );
}

export function OtcPrivacy({ settlement }: { settlement: boolean }) {
  return (
    <aside aria-label="Privacy at a glance" className={cn(otcPanel, 'overflow-hidden')}>
      <div className="flex items-center justify-between gap-2 border-b border-neutral-850 px-5 py-4">
        <h2 className="flex items-center gap-2 font-display text-[13px] uppercase">
          <OtcIcon name="ph--shield-check" className="h-4 w-4 text-primary" />
          What stays private
        </h2>
        <OtcSectionLink
          section="otc-privacy"
          className="font-term text-[10px] uppercase tracking-[0.12em] text-neutral-500 transition-colors hover:text-primary"
        >
          Details ↓
        </OtcSectionLink>
      </div>
      <dl className="divide-y divide-neutral-850 px-5">
        <PrivacyRow title="Offer and agreement" label="Off-chain">
          Only people with the link can review the terms, or just one wallet if you invite it.
        </PrivacyRow>
        {settlement && (
          <>
            <PrivacyRow title="Funding and withdrawal" label="Public">
              The assets, amounts and wallet addresses are visible on Solana.
            </PrivacyRow>
            <PrivacyRow title="Swap settlement" label="Encrypted">
              Helius Privacy Rings encrypts the assets and amounts in the swap. Wallet addresses
              stay visible.
            </PrivacyRow>
          </>
        )}
      </dl>
      {settlement && (
        <p className="flex gap-2 border-t border-neutral-850 bg-neutral-950/60 px-5 py-3 text-xs leading-relaxed text-neutral-400">
          <OtcIcon name="ph--info" className="mt-px h-3.5 w-3.5 text-neutral-500" />
          Matching public deposits and withdrawals can still reveal a trade.
        </p>
      )}
    </aside>
  );
}

function PrivacyRow({
  title,
  label,
  children,
}: {
  title: string;
  label: Visibility;
  children: ReactNode;
}) {
  return (
    <div className="py-4">
      <dt className="mb-1.5 flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-foreground">
        {title}
        <OtcVisibility label={label} />
      </dt>
      <dd className="text-xs leading-relaxed text-neutral-400">{children}</dd>
    </div>
  );
}

export function OtcExpiryTime({ date }: { date: string }) {
  return (
    <time dateTime={date} title={new Date(date).toLocaleString()}>
      {new Date(date).toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      })}
    </time>
  );
}
