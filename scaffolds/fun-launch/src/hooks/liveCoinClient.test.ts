import { describe, it, expect, vi, afterEach } from 'vitest';
import type { QueryClient } from '@tanstack/react-query';
import { watchLiveCoin, type LiveCoinEnvironment } from './liveCoinClient';
afterEach(() => vi.useRealTimers());
function fixture() {
  const document = Object.assign(new EventTarget(), { hidden: false }),
    window = new EventTarget(),
    navigator = { onLine: true },
    sources: Array<
      EventTarget & { close: ReturnType<typeof vi.fn>; onerror: ((event: Event) => unknown) | null }
    > = [],
    env = {
      document,
      window,
      navigator,
      createSource: () => {
        const source = Object.assign(new EventTarget(), {
          close: vi.fn(),
          onerror: null as ((event: Event) => unknown) | null,
        });
        sources.push(source);
        return source;
      },
    } as unknown as LiveCoinEnvironment;
  const invalidateQueries = vi.fn(async (_options: { queryKey: unknown[] }) => {}),
    client = { invalidateQueries } as unknown as QueryClient;
  return { document, window, navigator, sources, env, client, invalidateQueries };
}
describe('browser live transport lifecycle', () => {
  it('shares one stream, pauses hidden tabs, resumes visibly and closes after the last subscriber', () => {
    const f = fixture(),
      a = vi.fn(),
      b = vi.fn(),
      stopA = watchLiveCoin(f.client, 'mint', a, f.env),
      stopB = watchLiveCoin(f.client, 'mint', b, f.env);
    expect(f.sources).toHaveLength(1);
    f.sources[0]!.dispatchEvent(new Event('ready'));
    expect(a).toHaveBeenLastCalledWith(true);
    f.document.hidden = true;
    f.document.dispatchEvent(new Event('visibilitychange'));
    expect(f.sources[0]!.close).toHaveBeenCalledOnce();
    expect(b).toHaveBeenLastCalledWith(false);
    f.document.hidden = false;
    f.document.dispatchEvent(new Event('visibilitychange'));
    expect(f.sources).toHaveLength(2);
    stopA();
    expect(f.sources[1]!.close).not.toHaveBeenCalled();
    stopB();
    expect(f.sources[1]!.close).toHaveBeenCalledOnce();
  });
  it('cancels pending background updates and reconnects only after the browser is online', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      stop = watchLiveCoin(f.client, 'mint', vi.fn(), f.env);
    f.sources[0]!.dispatchEvent(new Event('update'));
    f.navigator.onLine = false;
    f.window.dispatchEvent(new Event('offline'));
    await vi.advanceTimersByTimeAsync(500);
    expect(f.invalidateQueries).not.toHaveBeenCalled();
    expect(f.sources[0]!.close).toHaveBeenCalledOnce();
    f.window.dispatchEvent(new Event('online'));
    expect(f.sources).toHaveLength(1);
    f.navigator.onLine = true;
    f.window.dispatchEvent(new Event('online'));
    expect(f.sources).toHaveLength(2);
    f.sources[1]!.dispatchEvent(new Event('ready'));
    expect(f.invalidateQueries).toHaveBeenCalled();
    stop();
  });
  it('coalesces update bursts and removes listeners when token subscriptions change', async () => {
    vi.useFakeTimers();
    const f = fixture(),
      stop = watchLiveCoin(f.client, 'mint', vi.fn(), f.env);
    f.sources[0]!.dispatchEvent(new Event('update'));
    f.sources[0]!.dispatchEvent(new Event('update'));
    await vi.advanceTimersByTimeAsync(350);
    expect(
      f.invalidateQueries.mock.calls.filter(
        (call) => (call[0] as { queryKey: string[] }).queryKey[0] === 'trades'
      )
    ).toHaveLength(1);
    stop();
    f.document.dispatchEvent(new Event('visibilitychange'));
    expect(f.sources).toHaveLength(1);
  });
});
