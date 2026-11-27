import { useState } from 'react';
import { feeMode, isFeeModeId } from '@/lib/feeModes';
import type { Coin } from '@/lib/coin';
import { explorerUrl } from '@/constants/network';
import { formatReadableNumber } from '@/lib/format/number';
import { SOCIAL_KINDS, SOCIAL_LABELS } from '@/lib/socials';
import { WalletIdentity } from '@/components/profiles/WalletIdentity';
import { SOCIAL_ICONS } from '@/components/coin/SocialLinks';
import { cn } from '@/lib/utils';
import { PanelSection } from './PanelSection';

export function TokenAbout({ coin }: { coin: Coin }) {
  const [expanded, setExpanded] = useState(false);
  const links = SOCIAL_KINDS.flatMap((kind) =>
    coin.socials?.[kind] ? [{ kind, href: coin.socials[kind]! }] : []
  );
  return (
    <PanelSection
      title={`About $${coin.symbol}`}
      label="About this token"
      aside={
        coin.mode && (
          <span className="chip border-primary/25 bg-primary/10 text-primary">
            {isFeeModeId(coin.mode)
              ? feeMode(coin.mode).label
              : coin.mode === 'bond'
                ? 'Bond it.'
                : coin.mode === 'creator'
                  ? 'Creator Fees'
                  : 'Community'}
          </span>
        )
      }
    >
      <p
        className={cn(
          'whitespace-pre-wrap break-words text-xs leading-relaxed text-neutral-400',
          !expanded && 'line-clamp-4'
        )}
      >
        {coin.description || 'The creator has not added a description.'}
      </p>
      {coin.description && coin.description.length > 160 && (
        <button
          type="button"
          onClick={() => setExpanded(!expanded)}
          className="mt-1 text-[11px] text-primary"
        >
          {expanded ? 'Show less' : 'Read more'}
        </button>
      )}

      {(links.length > 0 || coin.source) && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {links.map(({ kind, href }) => (
            <LinkChip key={kind} href={href} icon={SOCIAL_ICONS[kind]}>
              {SOCIAL_LABELS[kind]}
            </LinkChip>
          ))}
          {coin.source && (
            <LinkChip href={coin.source} icon="ph--quotes-bold">
              Original post on X
            </LinkChip>
          )}
        </div>
      )}

      <dl className="mt-3 divide-y divide-white/[0.05] border-t border-white/[0.06] text-[12px]">
        <Row label="Created by">
          <a
            href={coin.isDemo ? undefined : explorerUrl(`address/${coin.creator}`)}
            target="_blank"
            rel="noreferrer"
            className="text-neutral-300 hover:text-primary"
          >
            <WalletIdentity wallet={coin.creator} compact />
          </a>
        </Row>
        <Row label="Current supply">
          <span className="font-mono text-neutral-300">
            {coin.tokenSupply === undefined ? '—' : formatReadableNumber(coin.tokenSupply)}
          </span>
        </Row>
        <Row label="Pool">
          <span className="text-neutral-300">
            {coin.isMigrated ? 'Meteora DAMM v2' : 'Meteora bonding curve'}
          </span>
        </Row>
      </dl>
    </PanelSection>
  );
}

const Row = ({ label, children }: React.PropsWithChildren<{ label: string }>) => (
  <div className="flex h-8 items-center justify-between gap-2">
    <dt className="text-neutral-500">{label}</dt>
    <dd className="min-w-0 truncate">{children}</dd>
  </div>
);

const LinkChip = ({
  href,
  icon,
  children,
}: React.PropsWithChildren<{ href: string; icon: string }>) => (
  <a
    href={href}
    target="_blank"
    rel="noopener noreferrer nofollow"
    className="inline-flex h-8 items-center gap-1.5 rounded-full bg-white/[0.05] px-3 text-[11.5px] font-medium text-neutral-300 ring-1 ring-inset ring-white/[0.08] transition-all duration-200 ease-out hover:-translate-y-px hover:bg-white/[0.09] hover:text-foreground"
  >
    <span className={cn('iconify h-3.5 w-3.5', icon)} />
    {children}
  </a>
);
