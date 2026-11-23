import { useEffect, useMemo, useRef, useState } from 'react';
import { useCoins, usePrefetchCoin } from '@/hooks/useCoins';
import { useCoinPanel } from '@/hooks/useCoinPanel';
import { formatReadableNumber } from '@/lib/format/number';
import { cn } from '@/lib/utils';
import { CoinAvatar } from './coin/CoinAvatar';

/** Search coins by name, ticker or mint. Press "/" to focus. */
export const HeaderSearch = ({ className }: { className?: string }) => {
  const { data: coins } = useCoins();
  const { open } = useCoinPanel();
  const prefetch = usePrefetchCoin();
  const input = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^\$/, '');
    if (!q || !coins) return [];
    return coins
      .filter(
        (c) =>
          c.symbol.toLowerCase().includes(q) ||
          c.name.toLowerCase().includes(q) ||
          c.mint.toLowerCase() === q
      )
      .slice(0, 6);
  }, [coins, query]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (
        e.key === '/' &&
        !['INPUT', 'TEXTAREA'].includes(target.tagName) &&
        !target.isContentEditable
      ) {
        e.preventDefault();
        input.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  useEffect(() => setActive(0), [query]);

  const choose = (mint: string) => {
    open(mint);
    setQuery('');
    input.current?.blur();
  };

  return (
    <div className={cn('relative', className)}>
      <span className="iconify pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-neutral-500 ph--magnifying-glass" />
      <input
        ref={input}
        type="search"
        role="combobox"
        aria-expanded={focused && results.length > 0}
        aria-controls="search-results"
        aria-label="Search coins"
        placeholder="Search coins"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => setTimeout(() => setFocused(false), 120)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') setActive((a) => Math.min(a + 1, results.length - 1));
          else if (e.key === 'ArrowUp') setActive((a) => Math.max(a - 1, 0));
          else if (e.key === 'Enter' && results[active]) choose(results[active].mint);
          else if (e.key === 'Escape') input.current?.blur();
        }}
        className="h-9 w-full rounded-lg border border-neutral-850 bg-neutral-950 pl-9 pr-8 text-sm placeholder:text-neutral-600 focus:border-neutral-700 focus:outline-none"
      />
      <kbd className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 rounded border border-neutral-800 px-1 font-mono text-[10px] text-neutral-500">
        /
      </kbd>
      {focused && query && (
        <ul
          id="search-results"
          role="listbox"
          className="absolute inset-x-0 top-full z-50 mt-1.5 overflow-hidden rounded-lg border border-neutral-850 bg-neutral-950 py-1 shadow-xl"
        >
          {results.length ? (
            results.map((c, i) => (
              <li
                key={c.mint}
                role="option"
                aria-selected={i === active}
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(c.mint);
                }}
                onMouseEnter={() => {
                  setActive(i);
                  prefetch(c.mint);
                }}
                className={cn(
                  'flex cursor-pointer items-center gap-2.5 px-3 py-2',
                  i === active && 'bg-neutral-900'
                )}
              >
                <CoinAvatar
                  image={c.image}
                  symbol={c.symbol}
                  className="h-7 w-7 rounded-md text-xs"
                />
                <span className="min-w-0 flex-1 truncate text-sm">{c.name}</span>
                <span className="font-mono text-xs text-neutral-500">${c.symbol}</span>
                <span className="w-20 text-right font-mono text-xs tabular text-neutral-400">
                  {formatReadableNumber(c.marketCapSol)}
                </span>
              </li>
            ))
          ) : (
            <li className="px-3 py-3 text-sm text-neutral-500">No coins match “{query}”</li>
          )}
        </ul>
      )}
    </div>
  );
};
