import { useEffect, useRef, useState } from 'react';
import { glyph } from './Decrypt';

const FRAME_MS = 1000 / 30;
/** Chance that a digit that just changed shows one frame of noise; kept low so it stays readable. */
const CHANGE_GLITCH = 0.35;
/** Chance per frame that a settled digit flickers to noise while counting. */
const FLICKER = 0.06;
/** Frames of full scramble before 100 resolves. */
const FINALE_FRAMES = 5;

type Cell = { char: string; noise: boolean; lead: boolean };

const cells = (value: number): Cell[] =>
  String(value)
    .padStart(3, '0')
    .split('')
    .map((char, i) => ({ char, noise: false, lead: i < 3 - String(value).length }));

/**
 * Loading percentage for the first-visit splash, scrambled with the hero's Decrypt glyphs.
 * The splash has no real byte progress, so it eases toward 99 and runs to 100 once the
 * page's data has settled (`done`).
 */
export const SplashCounter = ({ done }: { done: boolean }) => {
  const [display, setDisplay] = useState<Cell[]>(() => cells(1));
  const doneRef = useRef(done);
  doneRef.current = done;

  useEffect(() => {
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const t0 = performance.now();
    const changedAt = [-99, -99, -99];
    let raf = 0,
      last = 0,
      frame = 0,
      value = 1,
      shown = 1,
      finale = -1;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      last = now;
      frame++;

      if (doneRef.current) value += Math.max(3, (100 - value) * 0.4);
      else {
        const target = 1 + 98 * (1 - Math.exp(-(now - t0) / 1100));
        // Uneven steps read as real loading rather than a smooth tween.
        if (Math.random() < 0.7) value += (target - value) * (0.08 + Math.random() * 0.2);
      }
      value = Math.min(doneRef.current ? 100 : 99, value);

      const next = Math.max(1, Math.floor(value));
      const prev = String(shown).padStart(3, '0');
      const now3 = String(next).padStart(3, '0');
      for (let i = 0; i < 3; i++) if (prev[i] !== now3[i]) changedAt[i] = frame;
      shown = next;

      if (next === 100 && finale < 0) finale = frame;
      const base = cells(next);
      if (reduced) {
        setDisplay(base);
        if (next === 100) cancelAnimationFrame(raf);
        return;
      }
      if (finale >= 0 && frame - finale > FINALE_FRAMES) {
        setDisplay(base);
        cancelAnimationFrame(raf);
        return;
      }
      setDisplay(
        base.map((cell, i) => {
          const scrambled =
            finale >= 0 ||
            (changedAt[i] === frame && Math.random() < CHANGE_GLITCH) ||
            Math.random() < (cell.lead ? FLICKER / 3 : FLICKER);
          return scrambled ? { ...cell, char: glyph(), noise: true } : cell;
        })
      );
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className="splash-count" aria-hidden="true">
      {display.map((cell, i) => (
        <span
          key={i}
          className={
            'splash-count-char' +
            (cell.lead && !cell.noise ? ' is-lead' : '') +
            (cell.noise ? ' is-noise' : '')
          }
        >
          {cell.char}
        </span>
      ))}
      <span className="splash-count-pct">%</span>
    </div>
  );
};
