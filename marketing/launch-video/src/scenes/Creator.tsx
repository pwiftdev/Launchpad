import React from 'react';
import { AbsoluteFill, Img, interpolate, useCurrentFrame } from 'remotion';
import { CUE, SCENES } from '../timing';
import { BOND, BODY, Burst, C, Display, HANDS, Sfx, ease, exitOut, holoText, pop } from '../ui';

const [START, END] = SCENES.creator;
const DUR = END - START;
const local = (cue: number) => cue - START;

/** Creators earn 0% until the coin bonds, then 0.5% of every trade, forever. */
export const Creator: React.FC = () => {
  const f = useCurrentFrame();
  const out = exitOut(f, DUR, 7);
  const enter = pop(f, 0);
  const fillStart = local(CUE.bondsBar) - 6;
  const bonded = local(CUE.bonds);
  const unlock = local(CUE.then);
  const half = local(CUE.halfPercent);
  const forever = local(CUE.forever);

  const fill = interpolate(f, [fillStart, bonded], [0.04, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
    easing: (t) => t * t * (3 - 2 * t),
  });
  const isBonded = f >= bonded;
  const stamp = pop(f, bonded, 1.4);
  const open = ease(f, unlock, 14);
  const flip = pop(f, half, 1.3);
  const value = interpolate(f, [half, half + 10], [0, 0.5], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });
  const inf = pop(f, forever, 1.2);
  const infDraw = interpolate(f, [forever, forever + 16], [0, 1], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' });

  return (
    <AbsoluteFill style={{ opacity: out, transform: `scale(${1 + (1 - out) * 0.1})` }}>
      {/* Label */}
      <div
        style={{
          position: 'absolute',
          top: 110,
          width: '100%',
          display: 'flex',
          justifyContent: 'center',
          transform: `scale(${enter})`,
        }}
      >
        <div
          style={{
            fontFamily: BODY,
            fontWeight: 700,
            fontSize: 30,
            letterSpacing: 8,
            color: C.muted,
            padding: '14px 30px',
            borderRadius: 999,
            background: 'rgba(5,6,15,0.35)',
            border: '2px solid rgba(255,255,255,0.12)',
          }}
        >
          CREATOR FEES
        </div>
      </div>

      {/* Lock + number */}
      <div
        style={{
          position: 'absolute',
          top: 230,
          width: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 40,
          transform: `scale(${enter})`,
        }}
      >
        <Lock open={open} />
        <Display
          size={230}
          style={{
            ...(f >= half ? holoText(`linear-gradient(90deg, ${C.lime}, ${C.green})`) : {}),
            transform: `scale(${f >= half ? 0.85 + flip * 0.15 : 1})`,
            minWidth: 520,
          }}
        >
          {f >= half ? `${value.toFixed(1)}%` : '0%'}
        </Display>
      </div>

      {/* forever */}
      <div
        style={{
          position: 'absolute',
          top: 520,
          width: '100%',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'center',
          gap: 22,
          opacity: Math.min(inf * 2, 1),
          transform: `scale(${inf})`,
        }}
      >
        <svg width={130} height={70} viewBox="0 0 130 70">
          <path
            d="M65 35 C50 10, 12 10, 12 35 C12 60, 50 60, 65 35 C80 10, 118 10, 118 35 C118 60, 80 60, 65 35"
            fill="none"
            stroke={C.lime}
            strokeWidth={12}
            strokeLinecap="round"
            pathLength={1}
            strokeDasharray={`${infDraw} 1`}
          />
        </svg>
        <Display size={64} style={{ color: C.lime }}>
          forever
        </Display>
      </div>

      {/* Bond bar */}
      <div style={{ position: 'absolute', top: 760, left: 150, width: 780 }}>
        <div
          style={{
            position: 'relative',
            height: 64,
            borderRadius: 999,
            background: 'rgba(5,6,15,0.45)',
            border: '3px solid rgba(255,255,255,0.14)',
            overflow: 'hidden',
          }}
        >
          <div
            style={{
              height: '100%',
              width: `${fill * 100}%`,
              borderRadius: 999,
              backgroundImage: BOND,
              backgroundSize: `${100 / Math.max(fill, 0.01)}% 100%`,
              boxShadow: isBonded ? `0 0 40px ${C.lime}` : 'none',
            }}
          />
        </div>
        {/* hands waiting at the finish */}
        <Img
          src={HANDS}
          style={{
            position: 'absolute',
            right: -70,
            top: -38,
            width: 140,
            height: 140,
            transform: `scale(${isBonded ? 1 + stamp * 0.25 : 0.8}) rotate(${isBonded ? Math.sin(f / 4) * 6 : 0}deg)`,
            filter: isBonded ? 'none' : 'grayscale(0.7) brightness(0.7)',
          }}
        />
        <div
          style={{
            marginTop: 26,
            display: 'flex',
            justifyContent: 'space-between',
            fontFamily: BODY,
            fontWeight: 700,
            fontSize: 30,
            letterSpacing: 4,
            color: C.muted,
          }}
        >
          <span style={{ opacity: isBonded ? 0.5 : 1 }}>BONDING…</span>
          <span
            style={{
              color: C.ink,
              background: C.lime,
              padding: '6px 18px',
              borderRadius: 12,
              transform: `scale(${stamp}) rotate(${(1 - stamp) * -12}deg)`,
              opacity: isBonded ? 1 : 0,
            }}
          >
            BONDED!
          </span>
        </div>
      </div>

      <Burst at={bonded} x={930} y={790} radius={240} seed="bonded" />
      <Burst at={half + 2} x={620} y={340} radius={300} count={16} seed="half" />

      <Sfx at={0} name="whoosh" volume={0.3} />
      <Sfx at={2} name="pop" volume={0.4} />
      <Sfx at={fillStart} name="rise" volume={0.3} />
      <Sfx at={bonded} name="sparkle" volume={0.35} />
      <Sfx at={unlock} name="chime" volume={0.35} />
      <Sfx at={half} name="pop" volume={0.5} />
      <Sfx at={forever} name="sparkle" volume={0.3} />
    </AbsoluteFill>
  );
};

/** Padlock whose shackle springs open. */
const Lock: React.FC<{ open: number }> = ({ open }) => (
  <svg width={150} height={190} viewBox="0 0 150 190" style={{ overflow: 'visible' }}>
    <g transform={`translate(${open * 42} ${-open * 26}) rotate(${open * 28} 112 70)`}>
      <path
        d="M38 88 V58 a37 37 0 0 1 74 0 V88"
        fill="none"
        stroke={open > 0.5 ? C.lime : '#D9DEFA'}
        strokeWidth={18}
        strokeLinecap="round"
      />
    </g>
    <rect x={10} y={82} width={130} height={104} rx={26} fill={open > 0.5 ? C.lime : '#D9DEFA'} />
    <circle cx={75} cy={128} r={13} fill={C.base} />
    <rect x={69} y={132} width={12} height={28} rx={6} fill={C.base} />
  </svg>
);
