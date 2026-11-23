import React from 'react';
import { AbsoluteFill, Audio, Sequence, interpolate, staticFile, useCurrentFrame } from 'remotion';
import { FPS, SCENES, VO_OFFSET } from './timing';
import { Backdrop, Grain } from './ui';
import { Hook } from './scenes/Hook';
import { Curve } from './scenes/Curve';
import { Creator } from './scenes/Creator';
import { AntiVamp } from './scenes/AntiVamp';
import { End } from './scenes/End';

const scene = ([from, to]: readonly [number, number]) => ({ from, durationInFrames: to - from });

/** plzzz.bond launch video: 30s, 1080x1080. Every scene is timed to the voiceover. */
export const LaunchVideo: React.FC = () => {
  const f = useCurrentFrame();
  // The backdrop brightens for the end card
  const glow = interpolate(f, [SCENES.end[0], SCENES.end[0] + 20], [0.85, 1.15], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  return (
    <AbsoluteFill>
      <Backdrop glow={glow} />
      <Sequence {...scene(SCENES.hook)}>
        <Hook />
      </Sequence>
      <Sequence {...scene(SCENES.curve)}>
        <Curve />
      </Sequence>
      <Sequence {...scene(SCENES.creator)}>
        <Creator />
      </Sequence>
      <Sequence {...scene(SCENES.antiVamp)}>
        <AntiVamp />
      </Sequence>
      <Sequence {...scene(SCENES.end)}>
        <End />
      </Sequence>
      <Grain />
      <Sequence from={Math.round(VO_OFFSET * FPS)}>
        <Audio src={staticFile('vo-final.wav')} volume={1} />
      </Sequence>
    </AbsoluteFill>
  );
};
