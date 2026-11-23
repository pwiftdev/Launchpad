import { useCallback } from 'react';
import { useLocalSetting } from './useLocalSetting';

const MAX_WATCHED = 50;
type StarredToken = { name: string; symbol: string; image: string | null };

/** Starred coins, saved in this browser. */
export function useWatchlist() {
  const [mints, setMints] = useLocalSetting<string[]>('rinsed.watchlist', []);
  const [tokens, setTokens] = useLocalSetting<Record<string, StarredToken>>(
    'rinsed.starred-tokens',
    {}
  );
  const [, setStrip] = useLocalSetting('rinsed.strip', 'watchlist');

  const add = useCallback(
    (mint: string, token?: StarredToken) => {
      const next = [mint, ...mints.filter((m) => m !== mint)].slice(0, MAX_WATCHED);
      if (token) {
        // Keep only small public metadata; never persist uploaded data URLs.
        const image =
          token.image?.startsWith('https://') || token.image?.startsWith('/demo/')
            ? token.image
            : null;
        const saved = {
          ...tokens,
          [mint]: { name: token.name.slice(0, 64), symbol: token.symbol.slice(0, 16), image },
        };
        setTokens(
          Object.fromEntries(
            next.flatMap((m) => {
              const value = saved[m];
              return value ? [[m, value]] : [];
            })
          )
        );
      }
      setMints(next);
      setStrip('watchlist');
    },
    [mints, tokens, setTokens, setMints, setStrip]
  );

  const isWatched = useCallback((mint: string) => mints.includes(mint), [mints]);
  const toggle = useCallback(
    (mint: string) => {
      if (mints.includes(mint)) setMints(mints.filter((m) => m !== mint));
      else add(mint);
    },
    [mints, setMints, add]
  );

  return { mints, tokens, isWatched, toggle, add };
}
