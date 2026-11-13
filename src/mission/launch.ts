// Launch from Earth: the story timeline and the reference ascent profile.
//
// OBSERVED reference points (NASA, rounded):
// - Countdown: flight crew boards about four hours before launch, crew access arm retracts at
//   T−8 min, main engines start at T−6.36 s, boosters ignite at T−0 (Artemis II press kit and
//   launch-day updates, 2026).
// - Ascent: tower clear and roll/pitch at +0:09, supersonic at +0:56, maximum dynamic pressure at
//   +1:10, booster separation at +2:08, launch abort system jettison at +3:18, core stage main
//   engine cutoff at +8:06, stage separation at +8:18 (Artemis II press kit).
// - Booster separation near 43.3 km at Mach 4.3; core stage reaches 28,003 km/h and more than
//   161.5 km before it separates (NASA SLS Reference Guide, 2022).
// MODELLED: every value between those points is interpolated, and so are the downrange distance
// and the pitch angle. The vehicle is conceptual; this is not a flight trajectory.

export type LaunchBeat = 'boarding' | 'armRetract' | 'countdown' | 'ascent';
export type LaunchEventId =
  | 'boarding' | 'armRetract' | 'holding' | 'engineStart' | 'liftoff' | 'towerClear' | 'supersonic' | 'maxQ'
  | 'boosterSep' | 'abortJettison' | 'meco' | 'stageSep';

// Story seconds: the screen time of each beat at normal speed.
export const LAUNCH_STORY = { boarding: 0, armRetract: 6.5, countdown: 9.5, liftoff: 14.5, end: 45.5 } as const;

// Mission elapsed time (seconds) of the ascent events.
export const MET = { towerClear: 9, supersonic: 56, maxQ: 70, boosterSep: 128, abortJettison: 198, meco: 486, stageSep: 498 } as const;
export const ENGINE_START_T = -6.36;
const COUNTDOWN_FROM = -7; // seconds on the clock when the countdown beat starts
const BOARDING_CLOCK = -4 * 3600; // crew ingress, about four hours before launch
const ARM_RETRACT_CLOCK = -8 * 60;

// Monotone cubic interpolation (Fritsch–Carlson): smooth, and never overshoots between points.
function curve(points: readonly (readonly [number, number])[]) {
  const n = points.length;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const slopes: number[] = [];
  for (let i = 0; i < n - 1; i += 1) slopes.push((ys[i + 1] - ys[i]) / (xs[i + 1] - xs[i]));
  const tangents: number[] = [slopes[0]];
  for (let i = 1; i < n - 1; i += 1) tangents.push(slopes[i - 1] * slopes[i] <= 0 ? 0 : (slopes[i - 1] + slopes[i]) / 2);
  tangents.push(slopes[n - 2]);
  for (let i = 0; i < n - 1; i += 1) {
    if (slopes[i] === 0) { tangents[i] = 0; tangents[i + 1] = 0; continue; }
    const a = tangents[i] / slopes[i];
    const b = tangents[i + 1] / slopes[i];
    const s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); tangents[i] = k * a * slopes[i]; tangents[i + 1] = k * b * slopes[i]; }
  }
  return (x: number) => {
    if (x <= xs[0]) return ys[0];
    if (x >= xs[n - 1]) return ys[n - 1];
    let i = 0;
    while (x > xs[i + 1]) i += 1;
    const h = xs[i + 1] - xs[i];
    const t = (x - xs[i]) / h;
    const t2 = t * t;
    const t3 = t2 * t;
    return (2 * t3 - 3 * t2 + 1) * ys[i] + (t3 - 2 * t2 + t) * h * tangents[i] + (-2 * t3 + 3 * t2) * ys[i + 1] + (t3 - t2) * h * tangents[i + 1];
  };
}

// Story seconds → mission elapsed time. The first seconds run close to real time; the rest of
// the eight-minute climb is compressed, slowing down again around each staging event.
const STORY_TO_MET: readonly (readonly [number, number])[] = [
  [LAUNCH_STORY.liftoff, 0], [19.5, 9], [24.5, 58], [27, 76], [30.6, 124], [33.6, 136], [36.4, 192], [38.8, 204], [42, 480], [45.5, 504],
];
const metCurve = curve(STORY_TO_MET);

// Reference profile. Columns: MET s, altitude km, speed km/h, downrange km, pitch from vertical (degrees).
const PROFILE: readonly (readonly [number, number, number, number, number])[] = [
  [0, 0, 0, 0, 0],
  [9, 0.13, 110, 0, 1],
  [30, 2.6, 560, 0.4, 12],
  [56, 8.5, 1100, 3, 30],
  [70, 12.8, 1560, 6, 38],
  [100, 26, 3100, 20, 52],
  [128, 43.3, 5000, 45, 62],
  [160, 64, 6600, 95, 70],
  [198, 89, 8700, 170, 75],
  [300, 128, 13500, 520, 82],
  [400, 150, 20000, 1050, 86],
  [486, 161.5, 28003, 1650, 88],
  [504, 162.5, 28003, 1790, 88],
];
const column = (index: number) => curve(PROFILE.map((row) => [row[0], row[index]] as const));
const altitudeCurve = column(1);
const speedCurve = column(2);
const downrangeCurve = column(3);
const pitchCurve = column(4);

export interface LaunchSample {
  story: number;
  beat: LaunchBeat;
  // Seconds relative to liftoff: negative before T−0, mission elapsed time after it.
  clock: number;
  met: number;
  altitudeKm: number;
  speedKmh: number;
  downrangeKm: number;
  pitch: number; // radians from vertical
  event: LaunchEventId;
}

export function metAtStory(story: number) {
  return story <= LAUNCH_STORY.liftoff ? 0 : metCurve(story);
}

// Story second at which the ascent reaches a mission elapsed time (inverse of metAtStory).
export function storyAtMet(met: number) {
  let low: number = LAUNCH_STORY.liftoff;
  let high: number = LAUNCH_STORY.end;
  for (let i = 0; i < 28; i += 1) {
    const mid = (low + high) / 2;
    if (metCurve(mid) < met) low = mid; else high = mid;
  }
  return (low + high) / 2;
}

export const STORY_AT = {
  engineStart: LAUNCH_STORY.countdown + ((ENGINE_START_T - COUNTDOWN_FROM) / -COUNTDOWN_FROM) * (LAUNCH_STORY.liftoff - LAUNCH_STORY.countdown),
  towerClear: storyAtMet(MET.towerClear),
  maxQ: storyAtMet(MET.maxQ),
  boosterSep: storyAtMet(MET.boosterSep),
  abortJettison: storyAtMet(MET.abortJettison),
  meco: storyAtMet(MET.meco),
  stageSep: storyAtMet(MET.stageSep),
} as const;

export function launchSample(story: number): LaunchSample {
  const s = Math.max(0, Math.min(LAUNCH_STORY.end, story));
  if (s < LAUNCH_STORY.armRetract) {
    return { story: s, beat: 'boarding', clock: BOARDING_CLOCK, met: 0, altitudeKm: 0, speedKmh: 0, downrangeKm: 0, pitch: 0, event: 'boarding' };
  }
  if (s < LAUNCH_STORY.countdown) {
    const clock = ARM_RETRACT_CLOCK + (s - LAUNCH_STORY.armRetract);
    return { story: s, beat: 'armRetract', clock, met: 0, altitudeKm: 0, speedKmh: 0, downrangeKm: 0, pitch: 0, event: 'armRetract' };
  }
  if (s < LAUNCH_STORY.liftoff) {
    const clock = COUNTDOWN_FROM * (1 - (s - LAUNCH_STORY.countdown) / (LAUNCH_STORY.liftoff - LAUNCH_STORY.countdown));
    return { story: s, beat: 'countdown', clock, met: 0, altitudeKm: 0, speedKmh: 0, downrangeKm: 0, pitch: 0, event: clock >= ENGINE_START_T ? 'engineStart' : 'holding' };
  }
  const met = metCurve(s);
  const event: LaunchEventId = met >= MET.stageSep ? 'stageSep' : met >= MET.meco ? 'meco' : met >= MET.abortJettison ? 'abortJettison' : met >= MET.boosterSep ? 'boosterSep'
    : met >= MET.maxQ ? 'maxQ' : met >= MET.supersonic ? 'supersonic' : met >= MET.towerClear ? 'towerClear' : 'liftoff';
  return {
    story: s, beat: 'ascent', clock: met, met,
    altitudeKm: altitudeCurve(met), speedKmh: speedCurve(met), downrangeKm: downrangeCurve(met),
    pitch: (pitchCurve(met) * Math.PI) / 180, event,
  };
}

// Reduced motion shows three still pictures instead of the full film: boarding, the pad, the climb.
export function storyFromProgress(progress: number, reduced: boolean) {
  const p = Math.max(0, Math.min(1, progress));
  if (!reduced) return p * LAUNCH_STORY.end;
  return p < 0.34 ? 3.2 : p < 0.67 ? 12.4 : 35.4;
}

// Live values for the HUD, written by the scene every frame.
export const launchLive: LaunchSample = launchSample(0);

// "T−00:08:00", "T+00:02:08". Hours show only when they are needed.
export function formatLaunchClock(clock: number) {
  const sign = clock < 0 ? '−' : '+';
  const total = clock < 0 ? Math.ceil(-clock) : Math.floor(clock);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const pad = (value: number) => String(value).padStart(2, '0');
  return `T${sign}${hours ? `${pad(hours)}:` : ''}${pad(minutes)}:${pad(seconds)}`;
}
