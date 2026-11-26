import { useEffect, useRef, useState } from 'react';

export function useOtcAction(onError?: (error: unknown) => void) {
  const lifetime = useRef<AbortController | null>(null);
  const running = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  async function run(work: (signal: AbortSignal) => Promise<void>) {
    const signal = lifetime.current?.signal;
    if (!signal || signal.aborted || running.current) return;
    running.current = true;
    setBusy(true);
    setError('');
    try {
      await work(signal);
    } catch (error) {
      if (!signal.aborted) {
        onError?.(error);
        setError(error instanceof Error ? error.message : 'Could not complete this request.');
      }
    } finally {
      running.current = false;
      if (!signal.aborted) setBusy(false);
    }
  }

  return { busy, error, run };
}
