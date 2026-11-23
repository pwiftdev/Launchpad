import React from 'react';
import { AbsoluteFill, interpolate, random, spring, useCurrentFrame } from 'remotion';
import { CUE, FPS, SCENES } from '../timing';
import { BOND, Burst, C, Coin, Display, Sfx, exitOut, holoText, pop } from '../ui';

const [START, END] = SCENES.curve;
const DUR = END - START;
const local = (cue: number) => cue - START;

// Chart box
const X0 = 150,
  X1 = 930,
  Y0 = 990,
  Y1 = 600;
/** The bonding curve: price rises faster the more is bought. */
const curveAt = (t: number) => ({ x: X0 + (X1 - X0) * t, y: Y0 - (Y0 - Y1) * Math.pow(t, 2.1) });
const path = (to: number) =>
  Array.from({ length: 61 }, (_, i) => {
    const p = curveAt((i / 60) * to);
    return `${i ? 'L' : 'M'}${p.x.toFixed(1)} ${p.y.toFixed(1)}`;
  }).join(' ');

const COINS = 9;
const COIN_EVERY = 7;
const FLIGHT = 14;

/** 100% of fees go back into the curve: coins pour into the curve and push the price up. */
export const Curve: React.FC = () => {
  const f = useCurrentFrame();
  const out = exitOut(f, DUR, 7);
  const hundred = pop(f, local(CUE.hundred), 1.25);
  const sub1 = pop(f, local(CUE.hundred) + 8);
  const sub2 = pop(f, local(CUE.backIntoCurve));
  const pumps = local(CUE.pumps);
  const coinStart = local(CUE.backIntoCurve) - 12;

  // How far up the curve we are: each landed coin nudges it, then the pump sends it flying
  const landed = Math.max(0, Math.min(COINS, Math.floor((f - coinStart - FLIGHT) / COIN_EVERY) + 1));
  const base = 0.12 + landed * 0.045;
  const pump = spring({ frame: f - pumps, fps: FPS, config: { damping: 11, stiffness: 90 } });
  const progress = Math.min(base + pump * (0.97 - base), 0.97);
  const draw = interpolate(f, [2, 26], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const dot = curveAt(progress * draw);
  const squash = 1 + Math.sin(Math.max(0, f - pumps) / 3) * 0.06 * Math.exp(-Math.max(0, f - pumps) / 14) * (f > pumps ? 1 : 0);

  return (
    <AbsoluteFill style={{ opacity: out, transform: `scale(${1 + (1 - out) * 0.1})` }}>
      {/* 100% */}
      <div style={{ position: 'absolute', top: 110, width: '100%', textAlign: 'center' }}>
        <Display
          size={215}
          style={{
            ...holoText(`linear-gradient(90deg, ${C.cyan}, ${C.lime} 60%, ${C.green})`),
            transform: `scale(${hundred}) rotate(${(1 - hundred) * -10}deg)`,
            opacity: Math.min(hundred * 2, 1),
            letterSpacing: -10,
          }}
        >
          100%
        </Display>
        <div style={{ position: 'relative', height: 70, marginTop: 14 }}>
          <Display
            size={50}
            style={{
              position: 'absolute',
              width: '100%',
              color: '#D9DEFA',
              opacity: Math.min(sub1 * 2, 1) * (1 - sub2),
              transform: `translateY(${(1 - sub1) * 30 - sub2 * 30}px)`,
            }}
          >
            of trading fees
          </Display>
          <Display
            size={50}
            style={{
              position: 'absolute',
              width: '100%',
              opacity: Math.min(sub2 * 2, 1),
              transform: `translateY(${(1 - sub2) * 30}px)`,
            }}
          >
            → back into the <span style={{ color: C.lime }}>curve</span>
          </Display>
        </div>
      </div>

      {/* Chart */}
      <svg
        width={1080}
        height={1080}
        style={{ position: 'absolute', inset: 0, transformOrigin: '540px 990px', transform: `scaleY(${squash})` }}
      >
        <defs>
          <linearGradient id="fill" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor={C.cobalt} stopOpacity="0.55" />
            <stop offset="0.6" stopColor={C.cyan} stopOpacity="0.45" />
            <stop offset="1" stopColor={C.lime} stopOpacity="0.55" />
          </linearGradient>
          <linearGradient id="stroke" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor={C.cobalt} />
            <stop offset="0.55" stopColor={C.cyan} />
            <stop offset="1" stopColor={C.lime} />
          </linearGradient>
        </defs>
        {/* baseline */}
        <line x1={X0} y1={Y0} x2={X1} y2={Y0} stroke="rgba(255,255,255,0.18)" strokeWidth={4} strokeLinecap="round" />
        {/* filled area up to the current price */}
        <path d={`${path(progress * draw)} L${dot.x} ${Y0} L${X0} ${Y0} Z`} fill="url(#fill)" />
        {/* the whole curve, faint, then the travelled part bright */}
        <path d={path(draw)} fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth={10} strokeLinecap="round" strokeDasharray="2 22" />
        <path d={path(progress * draw)} fill="none" stroke="url(#stroke)" strokeWidth={14} strokeLinecap="round" />
        {/* the price */}
        <circle cx={dot.x} cy={dot.y} r={34} fill={C.lime} opacity={0.25} />
        <circle cx={dot.x} cy={dot.y} r={18} fill="#fff" stroke={C.lime} strokeWidth={8} />
      </svg>

      {/* Fee coins flying into the curve */}
      {Array.from({ length: COINS }, (_, i) => {
        const t0 = coinStart + i * COIN_EVERY;
        const t = (f - t0) / FLIGHT;
        if (t < 0 || t > 1.15) return null;
        const from = { x: 300 + random(`cx${i}`) * 480, y: 470 };
        const target = curveAt(Math.min(0.12 + (i + 1) * 0.045, 0.6));
        const k = Math.min(t, 1);
        const x = from.x + (target.x - from.x) * k;
        const y = from.y + (target.y - from.y) * k - Math.sin(k * Math.PI) * 120;
        const s = t > 1 ? 1 - (t - 1) * 6 : interpolate(k, [0, 0.2], [0.3, 1], { extrapolateRight: 'clamp' });
        return (
          <div key={i} style={{ position: 'absolute', left: x - 36, top: y - 36, transform: `scale(${Math.max(s, 0)}) rotate(${k * 360}deg)` }}>
            <Coin size={72} />
          </div>
        );
      })}

      <Burst at={pumps + 10} x={curveAt(0.97).x} y={curveAt(0.97).y} radius={240} seed="pump" />

      <Sfx at={0} name="whoosh" volume={0.3} />
      <Sfx at={local(CUE.hundred)} name="pop" volume={0.5} />
      {Array.from({ length: COINS }, (_, i) => (
        <Sfx key={i} at={coinStart + i * COIN_EVERY + FLIGHT} name="coin" volume={0.16} />
      ))}
      <Sfx at={pumps} name="rise" volume={0.4} />
      <Sfx at={pumps + 10} name="sparkle" volume={0.3} />

      {/* hint of the bond line at the top of the chart */}
      <div
        style={{
          position: 'absolute',
          left: X1 - 4,
          top: Y1 - 60,
          height: 36,
          width: 8,
          borderRadius: 4,
          background: BOND,
          opacity: draw,
        }}
      />
    </AbsoluteFill>
  );
};
