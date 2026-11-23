import { useEffect, useState } from 'react';

// Offset between the server clock and this browser, so countdowns match the chain
// even when the user's computer clock is off.
let chainClock: { seconds: number; monotonicMs: number } | null = null;

export function syncServerClock(serverTimeSeconds: number) {
  if (!Number.isFinite(serverTimeSeconds) || serverTimeSeconds <= 0) return;
  chainClock = { seconds: serverTimeSeconds, monotonicMs: performance.now() };
}

/** Fixtures use browser time; real launches follow the last observed chain clock. */
export const nowSeconds = (isDemo = false) =>
  isDemo || !chainClock
    ? Date.now() / 1000
    : chainClock.seconds + (performance.now() - chainClock.monotonicMs) / 1000;

/** Current server-aligned time in seconds, re-rendering every `intervalMs`. */
export function useNow(intervalMs = 250, isDemo = false): number | null {
  // null until mounted, so server and client render the same markup
  const [now, setNow] = useState<number | null>(null);
  useEffect(() => {
    setNow(nowSeconds(isDemo));
    const id = setInterval(() => setNow(nowSeconds(isDemo)), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs, isDemo]);
  return now;
}
