import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from 'next/router';
import { BRAND } from '@/constants/brand';
import { SPLASH_SEEN_KEY, primarySplashQuery, splashQuerySettled, startSplash } from '@/lib/splash';
import { Wordmark } from './Logo';

// Measured from public/brand/mskd-portal.png (523x818): a point inside the left eye and the
// eye opening's extent around it, as fractions of the portal box.
const EYE = { x: 0.29254, y: 0.43154, left: 0.1109, right: 0.88719, top: 0.35575, bottom: 0.50733 };
// The eye opening is rounded, so cover the viewport with headroom
const COVER = 1.7;

const useIsoLayoutEffect = typeof window === 'undefined' ? useEffect : useLayoutEffect;

/**
 * First-visit intro: the balaclava on black. When the page is ready the camera flies through
 * the eye opening and the site appears behind it. Server-painted; readiness and an
 * independent deadline both release it.
 */
export const Splash = () => {
  const client = useQueryClient();
  const router = useRouter();
  const [phase, setPhase] = useState<'show' | 'leaving' | 'gone'>('show');
  const controller = useRef<ReturnType<typeof startSplash> | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const portal = useRef<HTMLDivElement>(null);
  const pathname = router.pathname;
  const mint = typeof router.query.tokenId === 'string' ? router.query.tokenId : undefined;

  // Scale needed for the eye opening to swallow the whole viewport from where it sits
  useIsoLayoutEffect(() => {
    const measure = () => {
      const box = portal.current?.getBoundingClientRect();
      if (!box || !root.current || !box.width) return;
      const ox = box.left + box.width * EYE.x,
        oy = box.top + box.height * EYE.y;
      const zoom =
        COVER *
        Math.max(
          ox / (box.width * (EYE.x - EYE.left)),
          (window.innerWidth - ox) / (box.width * (EYE.right - EYE.x)),
          oy / (box.height * (EYE.y - EYE.top)),
          (window.innerHeight - oy) / (box.height * (EYE.bottom - EYE.y))
        );
      root.current.style.setProperty('--zoom', zoom.toFixed(2));
    };
    measure();
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);

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

  if (phase === 'gone') return null;
  return (
    <div
      id="splash"
      ref={root}
      className={phase === 'leaving' ? 'splash splash-leave' : 'splash'}
      aria-label={`Loading ${BRAND.name}`}
      role="status"
    >
      <div ref={portal} className="splash-portal" aria-hidden="true" />
      <div className="splash-meta" aria-hidden="true">
        <Wordmark forceWhite className="splash-wordmark" />
        <span className="splash-line" />
      </div>
      <button type="button" className="splash-skip" onClick={() => controller.current?.leave()}>
        Enter
      </button>
    </div>
  );
};
