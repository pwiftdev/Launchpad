import React from 'react';
import { Composition } from 'remotion';
import { LaunchVideo } from './LaunchVideo';
import { DURATION, FPS, SIZE } from './timing';

export const Root: React.FC = () => (
  <Composition
    id="LaunchVideo"
    component={LaunchVideo}
    durationInFrames={DURATION}
    fps={FPS}
    width={SIZE}
    height={SIZE}
  />
);
