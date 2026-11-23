import React from 'react';
import { AbsoluteFill, Img, interpolate, random, useCurrentFrame } from 'remotion';
import { CUE, SCENES } from '../timing';
import { BODY, Burst, C, DISPLAY, Display, HANDS, Sfx, exitOut, pop } from '../ui';

const [START, END] = SCENES.antiVamp;
const DUR = END - START;
const local = (cue: number) => cue - START;

const CENTER = { x: 540, y: 600 };
const SHIELD_R = 230;

type Copycat = {
  label: string;
  /** Resting position */
  x: number;
  y: number;
  /** When it lunges at the shield */
  hit: number;
  face: 'ticker' | 'name' | 'picture';
};

const COPYCATS: Copycat[] = [
  { label: 'same ticker', x: 175, y: 330, hit: local(CUE.sameTicker), face: 'ticker' },
  { label: 'same name', x: 905, y: 330, hit: local(CUE.sameName), face: 'name' },
  { label: 'same picture', x: 540, y: 975, hit: local(CUE.samePicture), face: 'picture' },
];

/** Copycats bounce off the shield: same ticker, same name, same picture. Bonk. */
export const AntiVamp: React.FC = () => {
  const f = useCurrentFrame();
  const out = exitOut(f, DUR, 6);
  const ours = pop(f, 0);
  const shield = pop(f, local(CUE.blocked), 1.3);
  const bonk = local(CUE.bonk);
  const bonkPop = pop(f, bonk, 1.5);
  const shake = f >= bonk && f < bonk + 10 ? (random(`shake${f}`) - 0.5) * 26 : 0;

  return (
    <AbsoluteFill
      style={{
        opacity: out,
        transform: `translate(${shake}px, ${shake * 0.6}px) scale(${1 + (1 - out) * 0.1})`,
      }}
    >
      {/* Shield */}
      <div
        style={{
          position: 'absolute',
          left: CENTER.x - SHIELD_R,
          top: CENTER.y - SHIELD_R,
          width: SHIELD_R * 2,
          height: SHIELD_R * 2,
          borderRadius: '50%',
          background:
            'radial-gradient(circle, rgba(34,228,255,0.05) 55%, rgba(34,228,255,0.22) 85%, rgba(198,255,61,0.35) 100%)',
          border: `8px solid ${C.cyan}`,
          boxShadow: `0 0 60px rgba(34,228,255,0.6), inset 0 0 50px rgba(34,228,255,0.35)`,
          transform: `scale(${shield * (1 + flash(f) * 0.06)})`,
          opacity: Math.min(shield * 1.5, 1),
        }}
      />

      {/* Our coin */}
      <div
        style={{
          position: 'absolute',
          left: CENTER.x - 150,
          top: CENTER.y - 150,
          width: 300,
          height: 300,
          borderRadius: '50%',
          padding: 10,
          background: `linear-gradient(135deg, ${C.cobalt}, ${C.cyan}, ${C.lime}, ${C.violet})`,
          boxShadow: '0 30px 60px rgba(5,3,26,0.5)',
          transform: `scale(${ours}) translateY(${Math.sin(f / 8) * 6}px)`,
        }}
      >
        <div
          style={{
            width: '100%',
            height: '100%',
            borderRadius: '50%',
            background: 'radial-gradient(circle at 40% 30%, #1d2370, #0B0830 70%)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <Img src={HANDS} style={{ width: 210, height: 210 }} />
        </div>
      </div>

      {/* Copycats */}
      {COPYCATS.map((c, i) => {
        const enter = pop(f, 2 + i * 4);
        // lunge: in for 7 frames, then knocked back with a bounce
        const t = f - c.hit;
        const dx = CENTER.x - c.x,
          dy = CENTER.y - c.y;
        const dist = Math.hypot(dx, dy);
        const reach = (dist - SHIELD_R - 95) / dist;
        const lunge = t < 0 ? 0 : t < 7 ? interpolate(t, [0, 7], [0, reach], { easing: (v) => v * v }) : reach * Math.max(0, 1 - (t - 7) / 6) - Math.sin(Math.min((t - 7) / 10, 1) * Math.PI) * 0.12;
        // bonk: everyone flies off
        const fly = Math.max(0, f - bonk);
        const flyDist = fly * fly * 3.2;
        const nx = -dx / dist,
          ny = -dy / dist;
        const x = c.x + dx * lunge + nx * flyDist;
        const y = c.y + dy * lunge + ny * flyDist;
        const hitNow = t >= 7;
        const tag = pop(f, c.hit + 7, 1.3);
        return (
          <React.Fragment key={c.label}>
            <div
              style={{
                position: 'absolute',
                left: x - 95,
                top: y - 95,
                width: 190,
                height: 190,
                transform: `scale(${enter}) rotate(${fly * 22 + (hitNow && t < 14 ? Math.sin(t) * 14 : 0)}deg)`,
              }}
            >
              <CopycatCoin face={c.face} />
            </div>
            {/* label chip with a red cross */}
            <div
              style={{
                position: 'absolute',
                left: c.x - 150,
                top: c.face === 'picture' ? c.y - 175 : c.y + 112,
                width: 300,
                display: 'flex',
                justifyContent: 'center',
                opacity: f < bonk ? Math.min(tag * 2, 1) : Math.max(0, 1 - fly / 6),
                transform: `scale(${tag})`,
              }}
            >
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 10,
                  fontFamily: BODY,
                  fontWeight: 700,
                  fontSize: 30,
                  color: C.text,
                  padding: '10px 20px',
                  borderRadius: 999,
                  background: 'rgba(5,6,15,0.6)',
                  border: '2px solid rgba(255,77,120,0.6)',
                }}
              >
                <span style={{ color: '#FF4D78', fontSize: 34, fontFamily: DISPLAY }}>✕</span>
                {c.label}
              </div>
            </div>
            <Sfx at={c.hit + 7} name="bonk" volume={0.35} />
          </React.Fragment>
        );
      })}

      {/* "Copycats?" heading, then BONK */}
      <div
        style={{
          position: 'absolute',
          top: 90,
          width: '100%',
          textAlign: 'center',
          opacity: f < bonk ? Math.min(pop(f, 0) * 2, 1) : 0,
        }}
      >
        <Display size={72}>
          Copycats?{' '}
          <span style={{ color: '#FF4D78', opacity: Math.min(shield * 2, 1), display: 'inline-block', transform: `scale(${shield})` }}>
            Blocked.
          </span>
        </Display>
      </div>
      <div
        style={{
          position: 'absolute',
          top: 60,
          width: '100%',
          textAlign: 'center',
          opacity: f >= bonk ? 1 : 0,
          transform: `scale(${bonkPop}) rotate(${-6 + (1 - bonkPop) * -20}deg)`,
        }}
      >
        <Display
          size={170}
          style={{
            color: C.lime,
            WebkitTextStroke: `6px ${C.ink}`,
            paintOrder: 'stroke fill',
            textShadow: `0 12px 0 ${C.ink}, 0 20px 50px rgba(198,255,61,0.4)`,
          }}
        >
          BONK!
        </Display>
      </div>

      <Burst at={bonk} x={540} y={170} radius={320} count={18} seed="bonk" />

      <Sfx at={0} name="whoosh" volume={0.3} />
      <Sfx at={local(CUE.blocked)} name="chime" volume={0.25} />
      <Sfx at={bonk} name="bonk" volume={0.6} />
      <Sfx at={bonk + 1} name="pop" volume={0.45} />
    </AbsoluteFill>
  );

  /** Shield flinches briefly whenever a copycat hits it. */
  function flash(frame: number) {
    return COPYCATS.reduce((m, c) => {
      const t = frame - c.hit - 7;
      return t >= 0 && t < 8 ? Math.max(m, 1 - t / 8) : m;
    }, 0);
  }
};

/** A greyed knock-off coin: fake ticker, fake name, or our picture stolen. */
const CopycatCoin: React.FC<{ face: Copycat['face'] }> = ({ face }) => (
  <div
    style={{
      width: '100%',
      height: '100%',
      borderRadius: '50%',
      background: 'radial-gradient(circle at 38% 30%, #6a6f8f, #33364f 70%)',
      border: '6px solid #8A8FB0',
      boxShadow: '0 20px 40px rgba(5,3,26,0.5)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      overflow: 'hidden',
    }}
  >
    {face === 'picture' ? (
      <Img src={HANDS} style={{ width: 130, height: 130, filter: 'grayscale(1) contrast(0.8) brightness(0.9)' }} />
    ) : (
      <div style={{ fontFamily: DISPLAY, fontWeight: 800, fontSize: face === 'ticker' ? 38 : 30, color: '#DADCEB', textAlign: 'center', lineHeight: 1.1 }}>
        {face === 'ticker' ? '$PLZ' : 'Plz 2'}
      </div>
    )}
  </div>
);
