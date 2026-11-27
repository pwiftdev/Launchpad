export const SPLASH_SEEN_KEY = 'mskd.splash.v2';
export const SPLASH_MAX_MS = 3000;
/** Briefly hold the lockup even when data is already cached. */
export const SPLASH_MIN_MS = 600;
/** Keep the veil mounted until its CSS fade finishes. */
export const SPLASH_EXIT_MS = 640;
/** _document runs this before paint; storage failure simply leaves the first-visit veil in place. */
export const SPLASH_BOOT_SCRIPT = `try{if(sessionStorage.getItem(${JSON.stringify(SPLASH_SEEN_KEY)})==='1')document.documentElement.classList.add('no-splash')}catch(e){}`;

export function primarySplashQuery(pathname: string, mint: unknown): readonly string[] | null {
  if (pathname === '/') return ['coins'];
  if (pathname === '/token/[tokenId]' && typeof mint === 'string') return ['coin', mint];
  return null;
}

/** Errors are settled too: the page's own retry UI must become usable. */
export function splashQuerySettled(state: { status: string } | undefined): boolean {
  return state?.status === 'success' || state?.status === 'error';
}

/** Every subscription and timeout belongs to one effect, including the exit fade. */
export function startSplash(options: {
  ready: () => boolean;
  subscribe: (check: () => void) => () => void;
  onLeave: () => void;
  onGone: () => void;
  reducedMotion: boolean;
}) {
  let disposed = false;
  let leaving = false;
  let held = options.reducedMotion;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const clear = () => {
    for (const timer of timers) clearTimeout(timer);
    timers.clear();
  };
  const later = (callback: () => void, delay: number) => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!disposed) callback();
    }, delay);
    timers.add(timer);
  };
  const leave = () => {
    if (disposed || leaving) return;
    leaving = true;
    clear();
    options.onLeave();
    if (options.reducedMotion) options.onGone();
    else later(options.onGone, SPLASH_EXIT_MS);
  };
  const check = () => {
    if (held && options.ready()) leave();
  };
  const unsubscribe = options.subscribe(check);
  if (!held)
    later(() => {
      held = true;
      check();
    }, SPLASH_MIN_MS);
  later(leave, SPLASH_MAX_MS);
  check();
  return {
    leave,
    dispose: () => {
      disposed = true;
      clear();
      unsubscribe();
    },
  };
}
