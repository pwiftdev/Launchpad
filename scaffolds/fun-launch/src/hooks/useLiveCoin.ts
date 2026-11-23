import { useEffect, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { watchLiveCoin } from './liveCoinClient';
export { invalidateCoinQueries } from './liveCoinClient';
/** One connection per selected token, shared by price/trade/holder queries, with ordinary polling fallback. */
export function useLiveCoin(mint: string | undefined, enabled = true) {
  const client = useQueryClient(),
    [connected, setConnected] = useState(false);
  useEffect(() => {
    setConnected(false);
    if (
      !mint ||
      !enabled ||
      typeof EventSource === 'undefined' ||
      !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint)
    )
      return;
    return watchLiveCoin(client, mint, setConnected, {
      document,
      window,
      navigator,
      createSource: (url) => new EventSource(url),
    });
  }, [client, mint, enabled]);
  return { connected };
}
