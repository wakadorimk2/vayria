import type { PerformancePlan } from './types.js';

/** A short local glance and soft expression; no speech or network request. */
export function createViewerNoticePlan(base: PerformancePlan, reducedMotion: boolean): PerformancePlan {
  return {
    ...base,
    intent: 'react_nonverbally',
    actionDecision: undefined,
    speech: undefined,
    motion: undefined,
    behavior: undefined,
    preReaction: {
      leadBeforeSpeechMs: 850,
      gaze: { target: 'viewer', directness: 0.72 },
      expression: { emotion: 'joy', intensity: 0.24 },
      ...(reducedMotion ? {} : { motion: { weight: 0.65, headYawBias: 2 } }),
    },
  };
}
