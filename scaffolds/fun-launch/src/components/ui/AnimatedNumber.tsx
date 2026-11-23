import { useEffect, useRef, useState } from 'react';

type AnimatedNumberProps = {
  value: number;
  format: (n: number) => string;
  /** Tween length in ms */
  duration?: number;
  className?: string;
  title?: string;
};

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

/** Glides from the previous value to the new one instead of jumping. */
export const AnimatedNumber = ({
  value,
  format,
  duration = 600,
  className,
  title,
}: AnimatedNumberProps) => {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const frame = useRef<number | null>(null);

  useEffect(() => {
    const start = performance.now();
    const origin = from.current;
    if (origin === value || window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      from.current = value;
      setShown(value);
      return undefined;
    }
    const tick = (now: number) => {
      const t = Math.min((now - start) / duration, 1);
      const next = origin + (value - origin) * easeOut(t);
      from.current = next;
      setShown(next);
      if (t < 1) frame.current = requestAnimationFrame(tick);
    };
    frame.current = requestAnimationFrame(tick);
    return () => {
      if (frame.current) cancelAnimationFrame(frame.current);
    };
  }, [value, duration]);

  return (
    <span className={className} title={title}>
      {format(shown)}
    </span>
  );
};
