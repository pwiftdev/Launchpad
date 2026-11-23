// A quick burst of orange and white sparks from an element: starring a coin, a filled trade, a launch.

import { BRAND } from '@/constants/brand';
const COLORS = [BRAND.colors.orange, BRAND.colors.white, BRAND.colors.orange, BRAND.colors.grey];

/** Spawns `count` sparkles that fly out from the element's centre and fade. No-op for reduced motion. */
export function burstSparkles(origin: Element | null, count = 12) {
  if (!origin || typeof window === 'undefined') return;
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const rect = origin.getBoundingClientRect();
  const cx = rect.left + rect.width / 2;
  const cy = rect.top + rect.height / 2;

  for (let i = 0; i < count; i++) {
    const spark = document.createElement('span');
    const size = 7 + Math.random() * 11;
    const angle = (Math.PI * 2 * i) / count + Math.random() * 0.6;
    const distance = 30 + Math.random() * 46;
    spark.className = 'sparkle-pop';
    spark.style.cssText = [
      `left:${cx - size / 2}px`,
      `top:${cy - size / 2}px`,
      `width:${size}px`,
      `height:${size}px`,
      `--sparkle:${COLORS[i % COLORS.length]}`,
      `--dx:${Math.cos(angle) * distance}px`,
      `--dy:${Math.sin(angle) * distance - 16}px`,
      `animation-delay:${Math.random() * 70}ms`,
    ].join(';');
    document.body.appendChild(spark);
    spark.addEventListener('animationend', () => spark.remove(), { once: true });
  }
}
