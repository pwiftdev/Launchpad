import React from 'react';
import {
  AbsoluteFill,
  Audio,
  Img,
  Sequence,
  interpolate,
  random,
  spring,
  staticFile,
  useCurrentFrame,
} from 'remotion';
import { loadFont as loadUnbounded } from '@remotion/google-fonts/Unbounded';
import { loadFont as loadInter } from '@remotion/google-fonts/Inter';
import { FPS } from './timing';

export const DISPLAY = loadUnbounded('normal', { weights: ['700', '800', '900'], subsets: ['latin'] })
  .fontFamily;
export const BODY = loadInter('normal', { weights: ['600', '700'], subsets: ['latin'] }).fontFamily;

export const C = {
  base: '#0B0830',
  ink: '#05060F',
  cobalt: '#2440FF',
  cyan: '#22E4FF',
  lime: '#C6FF3D',
  green: '#1FE08A',
  violet: '#6D35FF',
  pink: '#FF3DAE',
  text: '#F4F6FF',
  muted: '#AAB4DC',
};
export const HOLO = `linear-gradient(100deg, ${C.cobalt}, ${C.cyan} 40%, ${C.lime} 65%, ${C.cyan} 85%, ${C.violet})`;
export const BOND = `linear-gradient(90deg, ${C.cobalt}, ${C.cyan} 55%, ${C.lime})`;

export const HANDS = staticFile('plzzz-mark.png');
export const WORDMARK = staticFile('plzzz-wordmark.png');

/** Bouncy 0→1 spring starting at `at` (frames). Overshoots a little: that is the "bubbly". */
export const pop = (frame: number, at: number, bounce = 1) =>
  spring({
    frame: frame - at,
    fps: FPS,
    config: { damping: 9 / bounce, stiffness: 170, mass: 0.7 },
  });

/** Calm 0→1 spring, no overshoot. */
export const ease = (frame: number, at: number, durationInFrames?: number) =>
  spring({ frame: frame - at, fps: FPS, config: { damping: 200 }, durationInFrames });

/** 1 → 0 over the last `len` frames of a scene of length `dur`. */
export const exitOut = (frame: number, dur: number, len = 7) =>
  interpolate(frame, [dur - len, dur], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

/** Drifting mesh gradient (violet, pink, green over cobalt) with film grain: the brand backdrop. */
export const Backdrop: React.FC<{ glow?: number }> = ({ glow = 1 }) => {
  const f = useCurrentFrame();
  const drift = (seed: number, amp: number) => Math.sin(f / 70 + seed) * amp;
  const blobs: [string, number, number, number, number][] = [
    [C.violet, 180 + drift(1, 60), 160 + drift(2, 40), 760, 0.95],
    [C.pink, 920 + drift(3, 50), 900 + drift(4, 50), 720, 0.8],
    [C.green, 90 + drift(5, 40), 960 + drift(6, 30), 600, 0.6],
    [C.cobalt, 540 + drift(7, 50), 500 + drift(8, 40), 640, 0.85],
    [C.cyan, 940 + drift(9, 40), 120 + drift(10, 30), 420, 0.35],
  ];
  return (
    <AbsoluteFill style={{ backgroundColor: C.base, overflow: 'hidden' }}>
      {blobs.map(([color, x, y, size, o], i) => (
        <div
          key={i}
          style={{
            position: 'absolute',
            left: x - size / 2,
            top: y - size / 2,
            width: size,
            height: size,
            borderRadius: '50%',
            background: color,
            opacity: o * glow,
            filter: 'blur(140px)',
          }}
        />
      ))}
      {/* Vignette */}
      <AbsoluteFill
        style={{
          background:
            'radial-gradient(circle at 50% 48%, rgba(0,0,0,0) 45%, rgba(3,2,16,0.55) 100%)',
        }}
      />
    </AbsoluteFill>
  );
};

/** Animated film grain over everything. */
export const Grain: React.FC = () => {
  const f = useCurrentFrame();
  return (
    <AbsoluteFill style={{ mixBlendMode: 'overlay', opacity: 0.16, pointerEvents: 'none' }}>
      <svg width="100%" height="100%">
        <filter id="grain">
          <feTurbulence
            type="fractalNoise"
            baseFrequency="0.85"
            numOctaves="2"
            seed={Math.floor(f / 2)}
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter="url(#grain)" />
      </svg>
    </AbsoluteFill>
  );
};

/** The iridescent hands with a breathing halo. */
export const Hands: React.FC<{ size: number; halo?: boolean; style?: React.CSSProperties }> = ({
  size,
  halo = true,
  style,
}) => {
  const f = useCurrentFrame();
  const breathe = 1 + Math.sin(f / 9) * 0.05;
  return (
    <div style={{ position: 'relative', width: size, height: size, ...style }}>
      {halo && (
        <div
          style={{
            position: 'absolute',
            inset: -size * 0.25,
            borderRadius: '50%',
            background: `radial-gradient(circle, rgba(34,228,255,0.45), rgba(36,64,255,0.18) 45%, rgba(0,0,0,0) 70%)`,
            transform: `scale(${breathe})`,
          }}
        />
      )}
      <Img
        src={HANDS}
        style={{
          position: 'relative',
          width: size,
          height: size,
          filter: 'drop-shadow(0 24px 40px rgba(5,3,26,0.55))',
        }}
      />
    </div>
  );
};

/** Four-point stars flying out from (x, y) at frame `at`. */
export const Burst: React.FC<{
  at: number;
  x: number;
  y: number;
  count?: number;
  radius?: number;
  seed?: string;
}> = ({ at, x, y, count = 14, radius = 220, seed = 'burst' }) => {
  const f = useCurrentFrame();
  const t = f - at;
  if (t < 0 || t > 28) return null;
  const colors = [C.cyan, C.lime, C.pink, C.violet, C.cyan];
  return (
    <>
      {Array.from({ length: count }, (_, i) => {
        const angle = (i / count) * Math.PI * 2 + random(`${seed}${i}a`) * 0.5;
        const dist = radius * (0.55 + random(`${seed}${i}d`) * 0.6);
        const p = interpolate(t, [0, 22], [0, 1], { extrapolateRight: 'clamp', easing: (v) => 1 - Math.pow(1 - v, 3) });
        const size = 14 + random(`${seed}${i}s`) * 26;
        const opacity = interpolate(t, [0, 4, 18, 28], [0, 1, 1, 0]);
        return (
          <div
            key={i}
            style={{
              position: 'absolute',
              left: x + Math.cos(angle) * dist * p - size / 2,
              top: y + Math.sin(angle) * dist * p - size / 2,
              width: size,
              height: size,
              background: colors[i % colors.length],
              clipPath: 'polygon(50% 0, 62% 38%, 100% 50%, 62% 62%, 50% 100%, 38% 62%, 0 50%, 38% 38%)',
              transform: `rotate(${t * 9}deg) scale(${1 - p * 0.4})`,
              opacity,
              filter: `drop-shadow(0 0 8px ${colors[i % colors.length]})`,
            }}
          />
        );
      })}
    </>
  );
};

/** A glossy fee coin. */
export const Coin: React.FC<{ size: number; style?: React.CSSProperties }> = ({ size, style }) => (
  <div
    style={{
      width: size,
      height: size,
      borderRadius: '50%',
      background: `radial-gradient(circle at 35% 30%, #F4FFD0 0%, ${C.lime} 28%, ${C.green} 70%, #0E8F5A 100%)`,
      boxShadow: `inset 0 -${size * 0.08}px ${size * 0.12}px rgba(0,60,30,0.45), 0 ${size * 0.12}px ${size * 0.3}px rgba(5,3,26,0.45)`,
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      fontFamily: DISPLAY,
      fontWeight: 900,
      fontSize: size * 0.5,
      color: '#0C5A36',
      ...style,
    }}
  >
    ◎
  </div>
);

/** A one-shot sound effect at frame `at`. */
export const Sfx: React.FC<{ at: number; name: string; volume?: number }> = ({
  at,
  name,
  volume = 0.35,
}) => (
  <Sequence from={at} durationInFrames={45} layout="none">
    <Audio src={staticFile(`sfx/${name}.wav`)} volume={volume} />
  </Sequence>
);

/** Big bold display text. */
export const Display: React.FC<{
  children: React.ReactNode;
  size: number;
  style?: React.CSSProperties;
}> = ({ children, size, style }) => (
  <div
    style={{
      fontFamily: DISPLAY,
      fontWeight: 800,
      fontSize: size,
      lineHeight: 1,
      letterSpacing: -size * 0.03,
      color: C.text,
      textShadow: '0 10px 40px rgba(5,3,26,0.45)',
      ...style,
    }}
  >
    {children}
  </div>
);

/** Text filled with the holo gradient. */
export const holoText = (gradient = `linear-gradient(90deg, ${C.cyan}, ${C.lime})`): React.CSSProperties => ({
  backgroundImage: gradient,
  WebkitBackgroundClip: 'text',
  backgroundClip: 'text',
  color: 'transparent',
  textShadow: 'none',
  filter: 'drop-shadow(0 10px 30px rgba(198,255,61,0.25))',
});
