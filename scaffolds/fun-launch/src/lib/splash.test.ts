import { runInNewContext } from 'node:vm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SPLASH_BOOT_SCRIPT,
  SPLASH_EXIT_MS,
  SPLASH_MAX_MS,
  SPLASH_MIN_MS,
  SPLASH_SEEN_KEY,
  primarySplashQuery,
  splashQuerySettled,
  startSplash,
} from './splash';

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
function mount(ready = false, reducedMotion = false) {
  let settled = ready;
  let notify: () => void = () => {};
  const gone = vi.fn(),
    leave = vi.fn(),
    unsubscribe = vi.fn();
  const controller = startSplash({
    ready: () => settled,
    subscribe: (callback) => {
      notify = callback;
      return unsubscribe;
    },
    onLeave: leave,
    onGone: gone,
    reducedMotion,
  });
  return {
    controller,
    gone,
    leave,
    unsubscribe,
    resolve: () => {
      settled = true;
      notify();
    },
  };
}
describe('first-visit splash lifecycle', () => {
  it('holds the lockup for the intro beat, then exits as soon as data is ready', () => {
    const first = mount(true);
    expect(first.leave).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SPLASH_MIN_MS);
    expect(first.leave).toHaveBeenCalledTimes(1);
    expect(first.gone).not.toHaveBeenCalled();
    vi.advanceTimersByTime(SPLASH_EXIT_MS);
    expect(first.gone).toHaveBeenCalledTimes(1);
    first.controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('reveals the page when data settles or a query fails, and keeps the deadline bounded', () => {
    const loading = mount();
    vi.advanceTimersByTime(10);
    expect(loading.leave).not.toHaveBeenCalled();
    loading.resolve();
    vi.advanceTimersByTime(SPLASH_MIN_MS + SPLASH_EXIT_MS);
    expect(loading.gone).toHaveBeenCalledTimes(1);
    loading.controller.dispose();
    const stalled = mount();
    vi.advanceTimersByTime(SPLASH_MAX_MS + SPLASH_EXIT_MS);
    expect(stalled.gone).toHaveBeenCalledTimes(1);
    stalled.controller.dispose();
    expect(splashQuerySettled({ status: 'error' })).toBe(true);
    expect(splashQuerySettled({ status: 'success' })).toBe(true);
    expect(splashQuerySettled({ status: 'loading' })).toBe(false);
    expect(splashQuerySettled(undefined)).toBe(false);
  });
  it('allows early manual entry and never starts a second fade or deadline callback', () => {
    const splash = mount();
    splash.controller.leave();
    splash.controller.leave();
    splash.resolve();
    vi.advanceTimersByTime(10_000);
    expect(splash.leave).toHaveBeenCalledTimes(1);
    expect(splash.gone).toHaveBeenCalledTimes(1);
    splash.controller.dispose();
  });
  it('cleans up both pending deadlines and exit timers during StrictMode effect replay', () => {
    const first = mount(true);
    first.controller.dispose();
    const second = mount(true);
    vi.advanceTimersByTime(10_000);
    expect(first.gone).not.toHaveBeenCalled();
    expect(second.gone).toHaveBeenCalledTimes(1);
    expect(first.unsubscribe).toHaveBeenCalledTimes(1);
    second.controller.dispose();
    const pending = mount();
    pending.controller.dispose();
    vi.advanceTimersByTime(10_000);
    expect(pending.leave).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('skips the fade for reduced motion while retaining the error escape', () => {
    const ready = mount(true, true);
    expect(ready.gone).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    ready.controller.dispose();
    const stalled = mount(false, true);
    vi.advanceTimersByTime(SPLASH_MAX_MS);
    expect(stalled.gone).toHaveBeenCalledTimes(1);
    stalled.controller.dispose();
  });
  it('waits on the actual primary page query rather than an unrelated board request', () => {
    expect(primarySplashQuery('/', undefined)).toEqual(['coins']);
    expect(primarySplashQuery('/token/[tokenId]', 'mint')).toEqual(['coin', 'mint']);
    expect(primarySplashQuery('/launch', undefined)).toBeNull();
    expect(primarySplashQuery('/whitelist', undefined)).toBeNull();
  });
  it('uses the same versioned key before paint and after hydration without depending on storage access', () => {
    expect(SPLASH_SEEN_KEY).toBe('mskd.splash.v2');
    const add = vi.fn(),
      get = vi.fn((key: string) => (key === SPLASH_SEEN_KEY ? '1' : null));
    const document = { documentElement: { classList: { add } } };
    runInNewContext(SPLASH_BOOT_SCRIPT, { sessionStorage: { getItem: get }, document });
    expect(add).toHaveBeenCalledWith('no-splash');
    add.mockClear();
    runInNewContext(SPLASH_BOOT_SCRIPT, {
      sessionStorage: { getItem: (key: string) => (key === 'mskd.splash.v1' ? '1' : null) },
      document,
    });
    expect(add).not.toHaveBeenCalled();
    expect(() =>
      runInNewContext(SPLASH_BOOT_SCRIPT, {
        sessionStorage: {
          getItem: () => {
            throw Error('blocked');
          },
        },
        document,
      })
    ).not.toThrow();
  });
});
