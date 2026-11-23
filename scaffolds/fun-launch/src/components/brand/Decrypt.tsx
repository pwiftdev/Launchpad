import { useEffect, useState } from 'react';
import { cn } from '@/lib/utils';

const GLYPHS = '▓▒░█<>/\\|_#$%&*+=?01';
const glyph = () => GLYPHS[(Math.random() * GLYPHS.length) | 0];

/**
 * Text that resolves from noise, left to right with jitter. Waits for the intro to finish
 * (html.no-splash) so the reveal is seen. Layout never shifts: the final text holds the space
 * and the scramble draws over it. Screen readers only ever get the final text.
 */
export const Decrypt = ({
  text,
  className,
  delay = 0,
  duration = 900,
}: {
  text: string;
  className?: string;
  delay?: number;
  duration?: number;
}) => {
  const [shown, setShown] = useState<string | null>(null);

  useEffect(() => {
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    let raf = 0,
      start = 0;
    const order = [...text].map((_, i) => (i / Math.max(1, text.length)) * 0.55 + Math.random() * 0.45);
    const tick = (now: number) => {
      if (!start) start = now + delay;
      const p = (now - start) / duration;
      if (p >= 1) {
        setShown(null);
        return;
      }
      setShown(
        [...text].map((ch, i) => (ch === ' ' ? ' ' : p > order[i] ? ch : glyph())).join('')
      );
      raf = requestAnimationFrame(tick);
    };
    const begin = () => {
      setShown(text.replace(/\S/g, glyph));
      raf = requestAnimationFrame(tick);
    };
    const root = document.documentElement;
    let observer: MutationObserver | null = null;
    if (root.classList.contains('no-splash')) begin();
    else {
      observer = new MutationObserver(() => {
        if (!root.classList.contains('no-splash')) return;
        observer?.disconnect();
        begin();
      });
      observer.observe(root, { attributes: true, attributeFilter: ['class'] });
    }
    return () => {
      observer?.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [text, delay, duration]);

  return (
    <span className={cn('relative inline-block whitespace-nowrap', className)}>
      <span className={shown === null ? undefined : 'opacity-0'}>{text}</span>
      {shown !== null && (
        <span aria-hidden className="absolute inset-0 overflow-hidden">
          {shown}
        </span>
      )}
    </span>
  );
};
