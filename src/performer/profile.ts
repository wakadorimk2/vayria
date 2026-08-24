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
  initialAutonomyDelayMs: 4_000,
  autonomyQuietTimeMinMs: 8_000,
  autonomyQuietTimeMaxMs: 18_000,
  leadBeforeSpeechMs: 180,
  motionLeadMs: 180,
  motionEnterBlendMs: 180,
  motionExitBlendMs: 400,
  motionPreparationTimeoutMs: 1_200,
  postSpeechHoldMs: 250,
};
