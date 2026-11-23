export const FPS = 30;
export const SIZE = 1080;
export const DURATION = 30 * FPS;

/** Silence before the voice starts. */
export const VO_OFFSET = 0.4;
/** A moment in the voiceover (seconds into take A) as a video frame. */
export const at = (voSeconds: number) => Math.round((voSeconds + VO_OFFSET) * FPS);

/**
 * Cue points, measured from the pauses in take A (ffmpeg silencedetect):
 * "Every coin deserves to bond." 0–2.27 · "On pleeez dot bond, one hundred percent … curve." 2.6–7.69 ·
 * "Every trade pumps your chart!" 8.0–9.87 · "Creators earn zero…" 10.26 · "until the coin bonds." 11.82 ·
 * "Then?" 13.44 · "Half a percent of every trade." 14.15 · "Forever." 16.25 · "Copycats? Blocked." 17.23 ·
 * "Same ticker, same name, same picture…" 19.24 · "bonk!" 22.45 · "Pleeez dot bond." 23.26 ·
 * "Live now." 24.82 · "Go on… pleeez bond it!" 25.74–28.15
 *
 * The voice read "Live now" like "live life", so vo-final.wav is take A with 24.68–25.60s cut out
 * (both cut points sit in pauses). Everything after the cut is 0.92s earlier than in take A;
 * "LIVE NOW" is now on screen only.
 */
export const CUE = {
  every: at(0),
  coin: at(0.35),
  deserves: at(0.75),
  toBond: at(1.35),
  bond: at(1.65),

  hundred: at(3.9),
  backIntoCurve: at(5.9),
  pumps: at(8.0),

  zero: at(10.26),
  bondsBar: at(11.82),
  bonds: at(12.75),
  then: at(13.44),
  halfPercent: at(14.15),
  forever: at(16.25),

  copycats: at(17.23),
  blocked: at(18.25),
  sameTicker: at(19.24),
  sameName: at(20.2),
  samePicture: at(21.1),
  bonk: at(22.45),

  brand: at(23.26),
  liveNow: at(24.6),
  bondIt: at(25.78),
};

/** Scene boundaries (frames). */
export const SCENES = {
  hook: [0, at(2.5)],
  curve: [at(2.5), at(10.1)],
  creator: [at(10.1), at(17.05)],
  antiVamp: [at(17.05), at(23.15)],
  end: [at(23.15), DURATION],
} as const;
