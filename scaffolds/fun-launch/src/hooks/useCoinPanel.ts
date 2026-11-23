import { useRouter } from 'next/router';
import { useCallback } from 'react';

// True when the panel was opened by a history push in this session,
// so closing can step back instead of leaving a duplicate history entry.
let openedByPush = false;

/** Call when the panel closes by other means (browser Back) so the flag can't go stale. */
export const resetPanelHistory = () => {
  openedByPush = false;
};

/**
 * The coin panel opens over the current page via a `?coin=<mint>` query param,
 * using shallow routing: no page load, shareable URL, and Back closes it.
 */
export function useCoinPanel() {
  const router = useRouter();
  const openMint = typeof router.query.coin === 'string' ? router.query.coin : undefined;

  const open = useCallback(
    (mint: string) => {
      const url = { pathname: router.pathname, query: { ...router.query, coin: mint } };
      if (openMint) {
        // Switching coins: replace, so Back still returns to the board
        router.replace(url, undefined, { shallow: true, scroll: false });
      } else {
        openedByPush = true;
        router.push(url, undefined, { shallow: true, scroll: false });
      }
    },
    [router, openMint]
  );

  const close = useCallback(() => {
    if (openedByPush) {
      openedByPush = false;
      router.back();
      return;
    }
    const { coin: _coin, ...query } = router.query;
    router.replace({ pathname: router.pathname, query }, undefined, {
      shallow: true,
      scroll: false,
    });
  }, [router]);

  return { openMint, open, close };
}
