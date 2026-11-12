// Shared approach beat. The landing machine stays on APPROACH the whole time;
// only the picture changes: Earth departure, compressed transit, then Mars closing.

export type ApproachSegment = 'earth' | 'transit' | 'mars';

export const approachLive: { segment: ApproachSegment } = { segment: 'earth' };

// Scene radius of the Earth globe. Mars stays at PLANET_RADIUS in SpaceScene.
export const EARTH_RADIUS = 72;

// Kennedy Space Center is near this latitude and longitude (OBSERVED).
// The pad and the rocket built there are still a fictional gameplay stand-in.
export const LAUNCH_LAT = 28.57;
export const LAUNCH_LON = -80.65;

export function approachDurations(reduced: boolean) {
  // Reduced motion keeps the story order but drops the prelude under two seconds.
  return reduced ? { earth: 0.55, transit: 0.6 } : { earth: 8, transit: 7 };
}
