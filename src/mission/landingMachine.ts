import type { SiteId } from './sites';

// Landing sequence state machine.
// APPROACH → SITE_SELECT → ENTRY → DESCENT → TOUCHDOWN → POST_LANDING → SETTLEMENT
// Every transition is listed explicitly; events that do not apply to the current
// stage are ignored, so repeated clicks or duplicate scene callbacks cannot skip a stage.

export type LandingStage = 'APPROACH' | 'SITE_SELECT' | 'ENTRY' | 'DESCENT' | 'TOUCHDOWN' | 'POST_LANDING' | 'SETTLEMENT';
export type Trajectory = 'divert' | 'direct';

export interface LandingState {
  stage: LandingStage;
  siteId: SiteId | null;
  trajectory: Trajectory | null;
  skipped: boolean;
  // Run in which the player skipped ahead to the trajectory decision (the decision is never skipped).
  fastForwardRun: number | null;
  replay: boolean;
  landed: boolean;
  run: number;
}

export type LandingEvent =
  | { type: 'CONTINUE' }
  | { type: 'SKIP' }
  | { type: 'CONFIRM_SITE'; siteId: SiteId }
  | { type: 'CHOOSE_TRAJECTORY'; trajectory: Trajectory }
  | { type: 'STAGE_COMPLETE'; stage: LandingStage; run: number }
  | { type: 'BEGIN_SURFACE_OPS' }
  | { type: 'REPLAY' }
  | { type: 'RESET' };

export const INITIAL_LANDING: LandingState = {
  stage: 'APPROACH', siteId: null, trajectory: null,
  skipped: false, fastForwardRun: null, replay: false, landed: false, run: 0,
};

const CINEMATIC: LandingStage[] = ['ENTRY', 'DESCENT', 'TOUCHDOWN'];

export function landingReducer(state: LandingState, event: LandingEvent): LandingState {
  if (event.type === 'RESET') return { ...INITIAL_LANDING, run: state.run + 1 };

  switch (state.stage) {
    case 'APPROACH':
      if (event.type === 'CONTINUE' || event.type === 'SKIP') return { ...state, stage: 'SITE_SELECT' };
      if (event.type === 'STAGE_COMPLETE' && event.stage === 'APPROACH') return state; // waits for the player
      return state;

    case 'SITE_SELECT':
      if (event.type === 'CONFIRM_SITE') return { ...state, stage: 'ENTRY', siteId: event.siteId, run: state.run + 1 };
      return state;

    case 'ENTRY':
    case 'DESCENT':
    case 'TOUCHDOWN': {
      if (event.type === 'SKIP') {
        // Skipping only fast-forwards the cinematic. If the landing decision has not been
        // made yet, jump to it instead of choosing a trajectory for the player.
        if (!state.trajectory) return { ...state, stage: 'DESCENT', fastForwardRun: state.run };
        return { ...state, stage: 'POST_LANDING', skipped: true, landed: true };
      }
      if (event.type === 'CHOOSE_TRAJECTORY' && state.stage === 'DESCENT' && state.trajectory === null) {
        return { ...state, trajectory: event.trajectory };
      }
      if (event.type !== 'STAGE_COMPLETE' || event.stage !== state.stage || event.run !== state.run) return state;
      if (state.stage === 'ENTRY') return { ...state, stage: 'DESCENT' };
      if (state.stage === 'DESCENT') return state.trajectory ? { ...state, stage: 'TOUCHDOWN' } : state;
      return { ...state, stage: 'POST_LANDING', landed: true };
    }

    case 'POST_LANDING':
      if (event.type === 'BEGIN_SURFACE_OPS') return { ...state, stage: 'SETTLEMENT', replay: false };
      return state;

    case 'SETTLEMENT':
      if (event.type === 'REPLAY' && state.siteId && state.trajectory) {
        return { ...state, stage: 'ENTRY', replay: true, run: state.run + 1 };
      }
      return state;
  }
}

export const isCinematic = (stage: LandingStage) => CINEMATIC.includes(stage);
export const isSpaceStage = (stage: LandingStage) => stage === 'APPROACH' || stage === 'SITE_SELECT' || stage === 'ENTRY';

// Stage durations in seconds of animation time (the descent pauses for the trajectory decision).
export const STAGE_SECONDS = { APPROACH: 13, ENTRY: 11, DESCENT: 19, TOUCHDOWN: 9 } as const;
// Fraction of DESCENT at which backshell separation happens and the trajectory must be chosen.
export const DECISION_POINT = 0.46;
