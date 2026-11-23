import { useTheme } from 'next-themes';
import { useEffect, useRef } from 'react';
import { cn } from '@/lib/utils';
import { BRAND } from '@/constants/brand';

// Floating soap bubbles for a page background: they rise, wobble, bump into each other,
// drift away from the cursor and pop when clicked. Drawn on one canvas from cached sprites.

const POP_COLORS = [BRAND.colors.orange, BRAND.colors.white, BRAND.colors.grey] as const;
const SPRITE = 256;
const R = SPRITE / 2 - 8; // bubble radius inside a sprite, leaving room for blur and stroke
// Clicks on these never pop a bubble behind them
const INTERACTIVE =
  'a,button,input,textarea,select,label,dialog,[role="button"],[role="radio"],[data-no-pop]';

type Bubble = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  far: boolean;
  phase: number;
  spin: number;
  angle: number;
  squash: number;
};
type Drop = {
  x: number;
  y: number;
  vx: number;
  vy: number;
  life: number;
  color: string;
  size: number;
};
type Ring = { x: number; y: number; r: number; life: number };

function sprite(draw: (ctx: CanvasRenderingContext2D, c: number) => void, blur = 0) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = SPRITE;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    if (blur) ctx.filter = `blur(${blur}px)`;
    draw(ctx, SPRITE / 2);
  }
  return canvas;
}

/** Clear centre, blue-to-pink iridescent rim and a pink sheen arc (the sprite turns, so the sheen drifts). */
function drawRim(ctx: CanvasRenderingContext2D, c: number, stroke: string) {
  const rim = ctx.createRadialGradient(c, c, 0, c, c, R);
  rim.addColorStop(0, 'rgba(22,217,245,0)');
  rim.addColorStop(0.62, 'rgba(22,217,245,0.02)');
  rim.addColorStop(0.82, 'rgba(22,217,245,0.2)');
  rim.addColorStop(0.94, 'rgba(247,49,186,0.34)');
  rim.addColorStop(1, 'rgba(255,255,255,0.35)');
  ctx.fillStyle = rim;
  ctx.beginPath();
  ctx.arc(c, c, R, 0, Math.PI * 2);
  ctx.fill();

  ctx.lineCap = 'round';
  ctx.strokeStyle = 'rgba(255,135,215,0.55)';
  ctx.lineWidth = R * 0.07;
  ctx.shadowColor = 'rgba(247,49,186,0.8)';
  ctx.shadowBlur = R * 0.12;
  ctx.beginPath();
  ctx.arc(c, c, R * 0.86, 0.15 * Math.PI, 0.55 * Math.PI);
  ctx.stroke();
  ctx.shadowBlur = 0;

  ctx.strokeStyle = stroke;
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(c, c, R - 1.5, 0, Math.PI * 2);
  ctx.stroke();
}

/** Light glints, drawn unrotated so the light always comes from the top left. */
function drawGlint(ctx: CanvasRenderingContext2D, c: number) {
  const spot = (x: number, y: number, r: number, alpha: number) => {
    const glow = ctx.createRadialGradient(x, y, 0, x, y, r);
    glow.addColorStop(0, `rgba(255,255,255,${alpha})`);
    glow.addColorStop(0.35, `rgba(255,255,255,${alpha * 0.8})`);
    glow.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fill();
  };
  spot(c - R * 0.4, c - R * 0.46, R * 0.2, 0.9);
  spot(c + R * 0.4, c + R * 0.52, R * 0.1, 0.3);
}

export const SoapBubbles = ({ className }: { className?: string }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { resolvedTheme } = useTheme();
  const light = resolvedTheme === 'light';

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return undefined;
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const stroke = light ? 'rgba(0,125,153,0.55)' : 'rgba(200,238,255,0.5)';
    const sprites = {
      rim: sprite((s, c) => drawRim(s, c, stroke)),
      glint: sprite(drawGlint),
      farRim: sprite((s, c) => drawRim(s, c, stroke), 4),
      farGlint: sprite(drawGlint, 4),
    };

    let w = 0;
    let h = 0;
    const bubbles: Bubble[] = [];
    const drops: Drop[] = [];
    const rings: Ring[] = [];
    const pointer = { x: -1e4, y: -1e4, vx: 0, vy: 0, at: 0 };
    let hovering = false;

    // A new bubble, by default just below the screen so it rises into view
    const make = (y?: number): Bubble => {
      const far = Math.random() < 0.35;
      // Smaller on phones so the big ones don't crowd the screen
      const scale = Math.min(Math.max(w / 1000, 0.7), 1);
      const r = (far ? 5 + Math.random() * 22 : 9 + Math.random() ** 2 * 60) * scale;
      return {
        x: r + Math.random() * Math.max(w - 2 * r, 1),
        y: y ?? h + r + Math.random() * 120,
        vx: 0,
        vy: -(10 + Math.random() * 20),
        r,
        far,
        phase: Math.random() * Math.PI * 2,
        spin: (Math.random() - 0.5) * 0.6,
        angle: Math.random() * Math.PI * 2,
        squash: 0,
      };
    };

    const resize = () => {
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      w = window.innerWidth;
      h = window.innerHeight;
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      const target = Math.round(Math.min(Math.max((w * h) / 52_000, 10), 26));
      while (bubbles.length < target) bubbles.push(make(Math.random() * h));
      bubbles.length = target;
      for (const b of bubbles) b.x = Math.min(Math.max(b.x, b.r), Math.max(w - b.r, b.r));
    };

    const step = (dt: number, t: number) => {
      for (const b of bubbles) {
        const depth = b.far ? 0.5 : 1;
        // Buoyancy eases towards a slow rise (bigger rises faster), plus a lazy side-to-side sway
        b.vy += (-(14 + b.r * 0.35) * depth - b.vy) * 0.8 * dt;
        b.vx += Math.sin(t * 0.9 + b.phase) * 14 * depth * dt;
        b.vx *= 1 - 0.9 * dt;

        // The cursor pushes bubbles aside and drags them along when it moves fast
        const dx = b.x - pointer.x;
        const dy = b.y - pointer.y;
        const reach = b.r + 90;
        const d2 = dx * dx + dy * dy;
        if (d2 < reach * reach) {
          const d = Math.sqrt(d2) || 1;
          const force = (1 - d / reach) * depth;
          b.vx += ((dx / d) * 520 + pointer.vx * 0.9) * force * dt;
          b.vy += ((dy / d) * 520 + pointer.vy * 0.9) * force * dt;
        }

        const speed = Math.hypot(b.vx, b.vy);
        if (speed > 600) {
          b.vx *= 600 / speed;
          b.vy *= 600 / speed;
        }
        b.x += b.vx * dt;
        b.y += b.vy * dt;
        b.angle += b.spin * dt;
        b.squash *= Math.max(1 - 5 * dt, 0);

        if (b.x < b.r) {
          b.x = b.r;
          b.vx = Math.abs(b.vx) * 0.6;
        } else if (b.x > w - b.r) {
          b.x = w - b.r;
          b.vx = -Math.abs(b.vx) * 0.6;
        }
        if (b.y > h + b.r + 200) b.y = h + b.r + 200;
        if (b.y < -b.r - 10) Object.assign(b, make());
      }

      // Bubbles in the same layer bump off each other (mass ~ area) and jiggle on impact
      for (let i = 0; i < bubbles.length; i++) {
        for (let j = i + 1; j < bubbles.length; j++) {
          const a = bubbles[i];
          const b = bubbles[j];
          if (!a || !b) continue;
          if (a.far !== b.far) continue;
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const min = a.r + b.r;
          const d2 = dx * dx + dy * dy;
          if (d2 >= min * min || d2 === 0) continue;
          const d = Math.sqrt(d2);
          const nx = dx / d;
          const ny = dy / d;
          const ma = a.r * a.r;
          const mb = b.r * b.r;
          const overlap = min - d;
          a.x -= (nx * overlap * mb) / (ma + mb);
          a.y -= (ny * overlap * mb) / (ma + mb);
          b.x += (nx * overlap * ma) / (ma + mb);
          b.y += (ny * overlap * ma) / (ma + mb);
          const closing = (b.vx - a.vx) * nx + (b.vy - a.vy) * ny;
          if (closing < 0) {
            const impulse = (-1.7 * closing) / (1 / ma + 1 / mb);
            a.vx -= (impulse / ma) * nx;
            a.vy -= (impulse / ma) * ny;
            b.vx += (impulse / mb) * nx;
            b.vy += (impulse / mb) * ny;
            const jiggle = Math.min(-closing / 400, 0.12);
            a.squash = Math.max(a.squash, jiggle);
            b.squash = Math.max(b.squash, jiggle);
          }
        }
      }

      for (const ring of rings) ring.life -= dt / 0.35;
      for (const drop of drops) {
        drop.life -= dt / 0.55;
        drop.vy += 700 * dt;
        drop.x += drop.vx * dt;
        drop.y += drop.vy * dt;
      }
      for (let i = rings.length - 1; i >= 0; i--) {
        const ring = rings[i];
        if (ring && ring.life <= 0) rings.splice(i, 1);
      }
      for (let i = drops.length - 1; i >= 0; i--) {
        const drop = drops[i];
        if (drop && drop.life <= 0) drops.splice(i, 1);
      }
      pointer.vx *= Math.max(1 - 8 * dt, 0);
      pointer.vy *= Math.max(1 - 8 * dt, 0);
    };

    const drawBubble = (b: Bubble, t: number) => {
      const size = (b.r / R) * SPRITE;
      const wobble = 0.025 * Math.sin(t * 2.4 + b.phase) + b.squash * Math.sin(t * 18 + b.phase);
      ctx.save();
      ctx.globalAlpha = b.far ? 0.55 : 1;
      ctx.translate(b.x, b.y);
      ctx.scale(1 + wobble, 1 - wobble);
      ctx.save();
      ctx.rotate(b.angle);
      ctx.drawImage(b.far ? sprites.farRim : sprites.rim, -size / 2, -size / 2, size, size);
      ctx.restore();
      ctx.drawImage(b.far ? sprites.farGlint : sprites.glint, -size / 2, -size / 2, size, size);
      ctx.restore();
    };

    const draw = (t: number) => {
      ctx.clearRect(0, 0, w, h);
      for (const b of bubbles) if (b.far) drawBubble(b, t);
      for (const b of bubbles) if (!b.far) drawBubble(b, t);
      for (const ring of rings) {
        ctx.strokeStyle = `rgba(255,190,222,${ring.life * 0.8})`;
        ctx.lineWidth = 2 * ring.life;
        ctx.beginPath();
        ctx.arc(ring.x, ring.y, ring.r * (1.35 - 0.35 * ring.life), 0, Math.PI * 2);
        ctx.stroke();
      }
      for (const drop of drops) {
        ctx.globalAlpha = drop.life;
        ctx.fillStyle = drop.color;
        ctx.beginPath();
        ctx.arc(drop.x, drop.y, drop.size, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
    };

    // Front bubbles first; small ones get a slightly bigger target
    const hit = (x: number, y: number) => {
      for (const far of [false, true]) {
        for (const b of bubbles) {
          const reach = Math.max(b.r, 14);
          if (b.far === far && (b.x - x) ** 2 + (b.y - y) ** 2 < reach * reach) return b;
        }
      }
      return null;
    };

    const pop = (b: Bubble) => {
      rings.push({ x: b.x, y: b.y, r: b.r, life: 1 });
      const count = Math.round(6 + b.r / 6);
      for (let i = 0; i < count; i++) {
        const angle = (i / count) * Math.PI * 2 + Math.random() * 0.5;
        const speed = 90 + Math.random() * 160 + b.r * 2;
        drops.push({
          x: b.x + Math.cos(angle) * b.r * 0.8,
          y: b.y + Math.sin(angle) * b.r * 0.8,
          vx: Math.cos(angle) * speed,
          vy: Math.sin(angle) * speed - 60,
          life: 1,
          color: POP_COLORS[i % POP_COLORS.length] ?? POP_COLORS[0],
          size: 1.2 + Math.random() * 2.2,
        });
      }
      // The burst nudges nearby bubbles away
      for (const other of bubbles) {
        if (other === b || other.far !== b.far) continue;
        const dx = other.x - b.x;
        const dy = other.y - b.y;
        const d = Math.hypot(dx, dy) || 1;
        const reach = b.r * 3 + other.r;
        if (d < reach) {
          other.vx += (dx / d) * 260 * (1 - d / reach);
          other.vy += (dy / d) * 260 * (1 - d / reach);
          other.squash = Math.max(other.squash, 0.08);
        }
      }
      Object.assign(b, make());
    };

    const blocked = (target: EventTarget | null) =>
      target instanceof Element && !!target.closest(INTERACTIVE);
    const setHover = (over: boolean) => {
      if (over === hovering) return;
      hovering = over;
      document.body.style.cursor = over ? 'pointer' : '';
    };
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || blocked(e.target)) return;
      const b = hit(e.clientX, e.clientY);
      if (b) pop(b);
    };
    const onMove = (e: PointerEvent) => {
      const now = performance.now();
      if (pointer.at && now - pointer.at < 100) {
        const dt = Math.max((now - pointer.at) / 1000, 0.008);
        pointer.vx = Math.max(Math.min((e.clientX - pointer.x) / dt, 2500), -2500);
        pointer.vy = Math.max(Math.min((e.clientY - pointer.y) / dt, 2500), -2500);
      }
      pointer.x = e.clientX;
      pointer.y = e.clientY;
      pointer.at = now;
      setHover(!blocked(e.target) && !!hit(e.clientX, e.clientY));
    };
    // A lifted finger or a cursor leaving the window stops pushing bubbles
    const onAway = (e?: PointerEvent) => {
      if (e && e.type === 'pointerup' && e.pointerType === 'mouse') return;
      pointer.x = pointer.y = -1e4;
      setHover(false);
    };

    resize();
    let frame = 0;
    const onResize = () => {
      resize();
      if (still) draw(0);
    };
    window.addEventListener('resize', onResize);
    if (still) {
      draw(0);
    } else {
      let last = performance.now();
      const loop = (now: number) => {
        const dt = Math.min((now - last) / 1000, 0.05);
        last = now;
        step(dt, now / 1000);
        draw(now / 1000);
        frame = requestAnimationFrame(loop);
      };
      frame = requestAnimationFrame(loop);
      window.addEventListener('pointerdown', onDown);
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onAway);
      document.documentElement.addEventListener('pointerleave', onAway);
    }

    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onResize);
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onAway);
      document.documentElement.removeEventListener('pointerleave', onAway);
      document.body.style.cursor = '';
    };
  }, [light]);

  return (
    <canvas
      ref={canvasRef}
      aria-hidden="true"
      className={cn('pointer-events-none fixed inset-0 h-full w-full', className)}
    />
  );
};
