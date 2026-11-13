// Shared approach beat. The landing machine stays on APPROACH the whole time;
// only the picture changes: Earth departure, compressed transit, then Mars closing.

import * as THREE from 'three';
import { LAUNCH_STORY } from '../mission/launch';

export type ApproachSegment = 'earth' | 'transit' | 'mars';

// launchProgress runs 0 → 1 through the 'earth' picture (boarding, countdown and the climb).
// mapsReady is set once the launch-coast imagery has loaded (or failed), so the film does not
// start over a blank ground.
export const approachLive: { segment: ApproachSegment; launchProgress: number; mapsReady: boolean } = { segment: 'earth', launchProgress: 0, mapsReady: false };

// Scene radius of the Earth globe. Mars stays at PLANET_RADIUS in SpaceScene.
export const EARTH_RADIUS = 72;

// NASA Kennedy Space Center, Launch Complex 39B (OBSERVED position).
// The tower, the rocket and the crew built there are a conceptual stand-in.
export const LAUNCH_LAT = 28.6272;
export const LAUNCH_LON = -80.6208;

export function approachDurations(reduced: boolean) {
  // Reduced motion keeps the story order as three still pictures.
  return reduced ? { earth: 2.4, transit: 0.6 } : { earth: LAUNCH_STORY.end, transit: 7 };
}

// One sun for the whole space scene, so Earth, the rocket and Mars are lit from the same side.
// At the pad this is a morning sun in the east-south-east, about 27° above the horizon.
export const SUN_DIRECTION = new THREE.Vector3(0.78, 0.46, 0.42).normalize();

// Development only, for checks and screenshots; both are null in normal play.
// ?launch=<story seconds> runs the launch film up to that moment and freezes it there.
// ?film=<seconds> starts the whole approach film at that second (the launch lasts LAUNCH_STORY.end).
function devNumber(name: string): number | null {
  if (!import.meta.env?.DEV || typeof window === 'undefined') return null;
  const value = new URLSearchParams(window.location.search).get(name);
  return value !== null && value !== '' && Number.isFinite(Number(value)) ? Number(value) : null;
}
export const launchHold = devNumber('launch');
export const filmStart = devNumber('film');
// ?capture: a script steps the render loop frame by frame (see WorldScene). The film then runs
// much slower than the wall clock, so timers that follow the wall clock are switched off.
export const captureMode = Boolean(import.meta.env?.DEV) && typeof window !== 'undefined' && new URLSearchParams(window.location.search).has('capture');
