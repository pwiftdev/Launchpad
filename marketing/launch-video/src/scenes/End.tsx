import React from 'react';
import { AbsoluteFill, Img, interpolate, useCurrentFrame } from 'remotion';
import { CUE, SCENES } from '../timing';
import { BODY, Burst, C, DISPLAY, HANDS, Hands, HOLO, Sfx, WORDMARK, pop } from '../ui';

const [START] = SCENES.end;
const local = (cue: number) => cue - START;

/** pleeez dot bond. Live now. pleeez bond it! */
export const End: React.FC = () => {
  const f = useCurrentFrame();
  const hands = pop(f, 0, 1.2);
  const word = pop(f, local(CUE.brand), 1.2);
  const live = pop(f, local(CUE.liveNow), 1.3);
  const cta = pop(f, local(CUE.bondIt), 1.4);
  const zoom = interpolate(f, [0, 195], [1, 1.04]);

  return (
    <AbsoluteFill style={{ transform: `scale(${zoom})` }}>
      <Hands
        size={330}
        style={{
          position: 'absolute',
          left: 540 - 165,
          top: 105,
          transform: `scale(${hands}) rotate(${(1 - hands) * 20 + Math.sin(f / 8) * 3}deg) translateY(${Math.sin(f / 11) * 8}px)`,
        }}
      />

      {/* Wordmark + .bond */}
      <div
        style={{
          position: 'absolute',
          top: 500,
          width: '100%',
          display: 'flex',
          justifyContent: 'center',
          alignItems: 'flex-end',
          gap: 12,
          transform: `scale(${word})`,
          opacity: Math.min(word * 2, 1),
        }}
      >
        <Img src={WORDMARK} style={{ width: 640, filter: 'drop-shadow(0 20px 40px rgba(5,3,26,0.6))' }} />
        <span style={{ fontFamily: DISPLAY, fontWeight: 700, fontSize: 60, color: C.lime, marginBottom: 14 }}>
          .bond
        </span>
      </div>

      {/* Live now */}
      <div
        style={{
          position: 'absolute',
          top: 700,
          width: '100%',
          display: 'flex',
          justifyContent: 'center',
          transform: `scale(${live})`,
          opacity: Math.min(live * 2, 1),
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 16,
            padding: '14px 30px',
            borderRadius: 999,
            background: 'rgba(5,6,15,0.5)',
            border: `3px solid ${C.green}`,
            fontFamily: BODY,
            fontWeight: 700,
            fontSize: 34,
            letterSpacing: 8,
            color: C.text,
          }}
        >
          <span
            style={{
              width: 20,
              height: 20,
              borderRadius: '50%',
              background: C.green,
              boxShadow: `0 0 ${14 + Math.sin(f / 4) * 10}px ${C.green}`,
            }}
          />
          LIVE NOW
        </div>
      </div>

      {/* CTA */}
      <div
        style={{
          position: 'absolute',
          top: 830,
          width: '100%',
          display: 'flex',
          justifyContent: 'center',
          transform: `scale(${cta}) rotate(${(1 - cta) * -6}deg)`,
          opacity: Math.min(cta * 2, 1),
        }}
      >
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 18,
            padding: '26px 54px',
            borderRadius: 999,
            backgroundImage: HOLO,
            backgroundSize: '200% 100%',
            backgroundPosition: `${(f % 90) / 0.9}% 0`,
            fontFamily: DISPLAY,
            fontWeight: 800,
            fontSize: 58,
            color: '#05081a',
            boxShadow: '0 24px 60px rgba(34,228,255,0.45), inset 0 3px 0 rgba(255,255,255,0.6)',
          }}
        >
          <Img src={HANDS} style={{ width: 64, height: 64 }} />
          plzzz bond it.
        </div>
      </div>

      <Burst at={local(CUE.brand) + 3} x={540} y={580} radius={420} count={18} seed="brand" />
      <Burst at={local(CUE.bondIt) + 3} x={540} y={895} radius={380} count={18} seed="cta" />

      <Sfx at={0} name="whoosh" volume={0.3} />
      <Sfx at={2} name="pop" volume={0.4} />
      <Sfx at={local(CUE.brand)} name="sparkle" volume={0.35} />
      <Sfx at={local(CUE.liveNow)} name="pop" volume={0.45} />
      <Sfx at={local(CUE.bondIt)} name="chime" volume={0.4} />
    </AbsoluteFill>
  );
};
