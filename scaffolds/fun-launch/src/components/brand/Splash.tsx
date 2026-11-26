import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import { BRAND } from '@/constants/brand';
import { SPLASH_SEEN_KEY, primarySplashQuery, splashQuerySettled, startSplash } from '@/lib/splash';
import { GrainField } from './GrainField';
import { LogoMark, Wordmark } from './Logo';
import { SplashCounter } from './SplashCounter';

export const Splash = ({ afterSplash }: { afterSplash?: ReactNode }) => {
  const client = useQueryClient();
  const router = useRouter();
  const [phase, setPhase] = useState<'show' | 'leaving' | 'gone'>('show');
  const controller = useRef<ReturnType<typeof startSplash> | null>(null);
  const pathname = router.pathname;
  const mint = typeof router.query.tokenId === 'string' ? router.query.tokenId : undefined;

  useEffect(() => {
    if (document.documentElement.classList.contains('no-splash')) {
      setPhase('gone');
      return;
    }
    const queryKey = primarySplashQuery(pathname, mint);
    const lifecycle = startSplash({
      ready: () => !queryKey || splashQuerySettled(client.getQueryState(queryKey)),
      subscribe: (check) => client.getQueryCache().subscribe(check),
      reducedMotion: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
      onLeave: () => {
        setPhase('leaving');
        try {
          sessionStorage.setItem(SPLASH_SEEN_KEY, '1');
        } catch {
          /* A blocked store never blocks entry. */
        }
      },
      onGone: () => {
        document.documentElement.classList.add('no-splash');
        setPhase('gone');
      },
    });
    controller.current = lifecycle;
    return () => {
      lifecycle.dispose();
      if (controller.current === lifecycle) controller.current = null;
    };
  }, [client, pathname, mint]);

  if (phase === 'gone') return afterSplash ?? null;
  return (
    <div id="splash" className={phase === 'leaving' ? 'splash splash-leave' : 'splash'}>
      <div className="splash-shade" aria-hidden="true" />
      <GrainField splash />
      <div className="splash-lockup" role="status" aria-label={`Loading ${BRAND.name}`}>
        <div className="splash-brand">
          <LogoMark small forceWhite className="splash-mark" />
          <Wordmark forceWhite className="splash-wordmark" />
        </div>
        <SplashCounter done={phase === 'leaving'} />
      </div>
      <button
        type="button"
        className="splash-skip"
        disabled={phase === 'leaving'}
        onClick={() => controller.current?.leave()}
      >
        Enter
      </button>
    </div>
  );
};
