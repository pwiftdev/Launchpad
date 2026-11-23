import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/router';
import { Dialog } from 'radix-ui';
import { usePrivacyMode } from '@/hooks/usePrivacyMode';
import { useCoins, usePrefetchCoin } from '@/hooks/useCoins';
import { useCoinPanel } from '@/hooks/useCoinPanel';
import { useWatchlist } from '@/hooks/useWatchlist';
import { NAV_ITEMS } from '@/constants/nav';
import { useUsd } from '@/hooks/useUsd';
import { cn } from '@/lib/utils';
import { CoinAvatar } from '../coin/CoinAvatar';
import { usePalette } from './paletteContext';

type Entry = {
  id: string;
  group: 'Coins' | 'Go to' | 'Actions';
  label: string;
  hint?: string;
  icon?: string;
  coin?: { image: string | null; symbol: string };
  run: () => void;
  prefetch?: () => void;
};

/** Ctrl/Cmd+K: jump to any coin, page or action. */
export const CommandPalette = () => {
  const { open, setOpen } = usePalette();
  const router = useRouter();
  const { data: coins } = useCoins();
  const { open: openCoin } = useCoinPanel();
  const prefetch = usePrefetchCoin();
  const { isWatched } = useWatchlist();
  const privacy = usePrivacyMode();
  const { usd } = useUsd();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (open) {
      setQuery('');
      setActive(0);
    }
  }, [open]);

  const entries = useMemo<Entry[]>(() => {
    const q = query.trim().toLowerCase().replace(/^\$/, '');
    const close = () => setOpen(false);
    const matchedCoins = (coins ?? [])
      .filter(
        (c) =>
          !q ||
          c.symbol.toLowerCase().includes(q) ||
          c.name.toLowerCase().includes(q) ||
          c.mint.toLowerCase() === q
      )
      // Without a query, show watched coins first, then the biggest
      .sort((a, b) =>
        q
          ? 0
          : Number(isWatched(b.mint)) - Number(isWatched(a.mint)) || b.marketCapSol - a.marketCapSol
      )
      .slice(0, q ? 8 : 5)
      .map<Entry>((c) => ({
        id: c.mint,
        group: 'Coins',
        label: c.name,
        hint: `$${c.symbol} · ${usd(c.marketCapSol)}`,
        coin: { image: c.image, symbol: c.symbol },
        run: () => {
          close();
          openCoin(c.mint);
        },
        prefetch: () => prefetch(c.mint),
      }));
    const pages: Entry[] = [
      { href: '/launch', label: 'Launch a coin', icon: 'ph--plus-bold' },
      ...NAV_ITEMS.map((n) => ({ href: n.href, label: n.label, icon: n.icon })),
    ]
      .filter((p) => !q || p.label.toLowerCase().includes(q))
      .map((p) => ({
        id: p.href,
        group: 'Go to',
        label: p.label,
        icon: p.icon,
        run: () => {
          close();
          router.push(p.href);
        },
      }));
    const actions: Entry[] = [
      {
        id: 'privacy',
        group: 'Actions' as const,
        label: privacy.enabled ? 'Turn off privacy mode' : 'Turn on privacy mode (blur addresses)',
        icon: 'ph--eye-slash',
        run: () => {
          close();
          privacy.toggle();
        },
      },
    ].filter((a) => !q || a.label.toLowerCase().includes(q));
    return [...matchedCoins, ...pages, ...actions];
  }, [coins, query, isWatched, privacy, router, openCoin, prefetch, setOpen, usd]);

  useEffect(() => setActive(0), [query]);
  useEffect(() => {
    list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  let lastGroup: Entry['group'] | null = null;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/50 backdrop-blur-[2px] data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed left-1/2 top-[12vh] z-50 w-[calc(100vw-24px)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-white/[0.09] bg-panel shadow-2xl outline-none data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-[0.98]"
        >
          <Dialog.Title className="sr-only">Search</Dialog.Title>
          <div className="flex items-center gap-3 border-b border-neutral-850 px-4">
            <span className="iconify h-5 w-5 text-neutral-500 ph--magnifying-glass" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setActive((a) => Math.min(a + 1, entries.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setActive((a) => Math.max(a - 1, 0));
                } else if (e.key === 'Enter') {
                  entries[active]?.run();
                }
              }}
              placeholder="Search coins, pages, actions…"
              aria-label="Search"
              role="combobox"
              aria-expanded
              aria-controls="palette-list"
              className="h-14 flex-1 bg-transparent text-base outline-none placeholder:text-neutral-600"
            />
            <kbd className="rounded border border-neutral-800 px-1.5 font-mono text-[10px] text-neutral-500">
              Esc
            </kbd>
          </div>
          <ul
            id="palette-list"
            ref={list}
            role="listbox"
            className="max-h-[56vh] overflow-y-auto p-2"
          >
            {entries.length === 0 && (
              <li className="px-3 py-8 text-center text-sm text-neutral-500">
                Nothing matches “{query}”
              </li>
            )}
            {entries.map((entry, i) => {
              const header = entry.group !== lastGroup ? entry.group : null;
              lastGroup = entry.group;
              return (
                <li key={entry.id} role="presentation">
                  {header && <p className="eyebrow px-3 pb-1 pt-3 first:pt-1">{header}</p>}
                  <div
                    role="option"
                    aria-selected={i === active}
                    data-index={i}
                    onMouseMove={() => {
                      if (i !== active) setActive(i);
                      entry.prefetch?.();
                    }}
                    onClick={entry.run}
                    className={cn(
                      'flex cursor-pointer items-center gap-3 rounded-lg px-3 py-2.5 text-sm',
                      i === active ? 'bg-neutral-900 text-foreground' : 'text-neutral-300'
                    )}
                  >
                    {entry.coin ? (
                      <CoinAvatar
                        image={entry.coin.image}
                        symbol={entry.coin.symbol}
                        className="h-7 w-7 rounded-md text-xs"
                      />
                    ) : (
                      <span className="flex h-7 w-7 items-center justify-center rounded-md bg-neutral-900 text-neutral-400">
                        <span className={cn('iconify h-4 w-4', entry.icon)} />
                      </span>
                    )}
                    <span className="min-w-0 flex-1 truncate">{entry.label}</span>
                    {entry.hint && (
                      <span className="font-mono text-xs text-neutral-500">{entry.hint}</span>
                    )}
                    {i === active && (
                      <span className="iconify h-4 w-4 text-neutral-500 ph--arrow-elbow-down-left" />
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
