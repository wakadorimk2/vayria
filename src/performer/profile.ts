import type { PerformerProfile } from './types.js';

export const DEFAULT_PERFORMER_PROFILE: PerformerProfile = {
  initiativeBaseline: 0.58,
  emotionalInertia: 0.62,
  fragmentationBaseline: 0.08,
  callbackTendencyBaseline: 0.2,
  gazeDirectnessBaseline: 0.72,
  emotionDecayHalfLifeMs: 18_000,
  attentionDecayHalfLifeMs: 7_000,
  energyBaseline: 0.68,
  responseDelayBaselineMs: 260,
  leadBeforeSpeechMs: 180,
  autonomousInitialDelayMs: 4_000,
  autonomousMinDelayMs: 8_000,
  autonomousMaxDelayMs: 18_000,
};
