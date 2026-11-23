import React from 'react';
import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { CUE, SCENES } from '../timing';
import { Burst, Display, Hands, Sfx, exitOut, holoText, pop } from '../ui';

const [START, END] = SCENES.hook;
const DUR = END - START;

/** "Every coin deserves to bond." The hands pop in and the line lands word by word. */
export const Hook: React.FC = () => {
  const f = useCurrentFrame();
  const hands = pop(f, 0, 1.2);
  const out = exitOut(f, DUR, 6);
  const words: [string, number][] = [
    ['Every', CUE.every],
    ['coin', CUE.coin],
    ['deserves', CUE.deserves],
  ];
  const bond = pop(f, CUE.bond, 1.3);
  const to = pop(f, CUE.toBond);

  return (
    <AbsoluteFill
      style={{
        alignItems: 'center',
        justifyContent: 'center',
        opacity: out,
        transform: `scale(${1 + (1 - out) * 0.12})`,
      }}
    >
      <Hands
        size={420}
        style={{
          position: 'absolute',
          top: 120,
          transform: `scale(${hands}) rotate(${(1 - hands) * -24 + Math.sin(f / 7) * 3}deg) translateY(${Math.sin(f / 10) * 8}px)`,
        }}
      />
      <div style={{ position: 'absolute', top: 640, width: '100%', textAlign: 'center' }}>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 22 }}>
          {words.map(([w, at]) => {
            const s = pop(f, at);
            return (
              <Display
                key={w}
                size={74}
                style={{ transform: `scale(${s}) translateY(${(1 - s) * 40}px)`, opacity: Math.min(s * 2, 1) }}
              >
                {w}
              </Display>
            );
          })}
        </div>
        <div style={{ display: 'flex', justifyContent: 'center', gap: 28, marginTop: 18 }}>
          <Display size={124} style={{ transform: `scale(${to})`, opacity: Math.min(to * 2, 1) }}>
            to
          </Display>
          <Display
            size={124}
            style={{
              ...holoText(),
              transform: `scale(${bond}) rotate(${(1 - bond) * 8}deg)`,
              opacity: Math.min(bond * 2, 1),
            }}
          >
            bond.
          </Display>
        </div>
      </div>
      <Burst at={CUE.bond + 2} x={760} y={830} radius={260} seed="hook" />
      <Sfx at={0} name="pop" volume={0.45} />
      <Sfx at={CUE.bond} name="sparkle" volume={0.3} />
      {/* subtle scale-in of the whole frame so the start never feels static */}
      <AbsoluteFill style={{ pointerEvents: 'none', opacity: interpolate(f, [0, 8], [1, 0], { extrapolateRight: 'clamp' }), background: '#0B0830' }} />
    </AbsoluteFill>
  );
};
