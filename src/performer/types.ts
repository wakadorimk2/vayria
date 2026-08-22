import type { Emotion } from '../character/emotion.js';
import type { VoiceInteractionAction } from '../voice/voiceInteraction.js';

export type AttentionTarget = 'viewer' | 'chat' | 'game' | 'none';

export type ExternalStimulusMetadata = Readonly<Record<string, string>>;

export type PerformerPhase =
  | 'idle'
  | 'scheduled'
  | 'waiting'
  | 'synthesizing'
  | 'speaking'
  | 'cooldown'
  | 'error';

export type PerformerTrigger =
  | {
      kind: 'viewer_message';
      text: string;
    }
  | {
      kind: 'idle_tick';
      elapsedMs: number;
    }
  | {
      kind: 'external_stimulus';
      semanticCue: string;
      metadata?: ExternalStimulusMetadata;
    }
  | {
      kind: 'memory_callback';
      semanticCue: string;
    };

export interface PerformerState {
  phase: PerformerPhase;
  energy: number;
  emotion: {
    value: Emotion;
    activation: number;
    updatedAt: number;
  };
  attention: {
    target: AttentionTarget;
    strength: number;
    updatedAt: number;
  };
  lastSpeechAt: number | null;
  lastViewerMessageAt: number | null;
}

export interface PerformerProfile {
  initiativeBaseline: number;
  emotionalInertia: number;
  fragmentationBaseline: number;
  callbackTendencyBaseline: number;
  gazeDirectnessBaseline: number;
  emotionDecayHalfLifeMs: number;
  attentionDecayHalfLifeMs: number;
  energyBaseline: number;
  responseDelayBaselineMs: number;
  leadBeforeSpeechMs: number;
  motionLeadMs: number;
  motionEnterBlendMs: number;
  motionExitBlendMs: number;
  motionPreparationTimeoutMs: number;
  postSpeechHoldMs: number;
  autonomousInitialDelayMs: number;
  autonomousMinDelayMs: number;
  autonomousMaxDelayMs: number;
}

export type BehaviorStance =
  | 'inquisitive'
  | 'skeptical'
  | 'drowsy'
  | 'weathered'
  | 'awed'
  | 'timid'
  | 'curious'
  | 'seeking'
  | 'secretive'
  | 'alarmed'
  | 'delighted'
  | 'buoyant'
  | 'withdrawn'
  | 'assertive'
  | 'uncanny'
  | 'uncertain'
  | 'vigilant'
  | 'disoriented';

export type CardGestureIntent =
  | 'inspect'
  | 'withdraw'
  | 'expand'
  | 'contract'
  | 'release'
  | 'lean_in'
  | 'self_hold'
  | 'look_up'
  | 'conceal'
  | 'brace'
  | 'open'
  | 'sway'
  | 'lower'
  | 'present'
  | 'freeze'
  | 'stare'
  | 'scan'
  | 'orient';

export interface PerformanceBehavior {
  stance: BehaviorStance;
  energy: 'low' | 'medium' | 'high';
  engagement: 'direct' | 'cautious' | 'inward' | 'distant';
  gestureIntent: CardGestureIntent;
}

export interface DirectionModifiers {
  responseDelayMs: number;
  initiative: number;
  emotionalInertia: number;
  speechFragmentation: number;
  callbackTendency: number;
  gazeDirectness: number;
  attentionStrength: number;
  energy: number;
  ttsRateScale: number;
  ttsIntonationScale: number;
  idleMotionWeight: number;
  headYawBias: number;
  semanticBiases: readonly string[];
}

export interface DirectionEffect {
  id: string;
  directionId: string;
  sourceId: string;
  startedAt: number;
  intensity: number;
  durationMs?: number;
  decay: 'none' | 'linear' | 'exponential';
  modifiers: Partial<DirectionModifiers>;
}

export type DirectionConstraint = {
  kind: 'require_speech';
  scope: 'current_plan';
};

export interface DirectionContribution {
  directionId: string;
  effects: DirectionEffect[];
  constraints: DirectionConstraint[];
  semanticCues: string[];
  triggers: PerformerTrigger[];
  attentionTarget?: AttentionTarget;
}

export interface ActionIntent {
  trigger: PerformerTrigger['kind'];
  preferredIntent: 'speak' | 'wait' | 'ignore' | 'react_nonverbally';
  attentionTarget: AttentionTarget;
  emotionCue?: {
    emotion: Emotion;
    intensity: number;
  };
  speechContext: {
    callbackTendency: number;
    fragmentation: number;
    semanticBiases: string[];
  };
}

export interface PerformanceTiming {
  motionLeadMs: number;
  motionEnterBlendMs: number;
  motionExitBlendMs: number;
  motionPreparationTimeoutMs: number;
  postSpeechHoldMs: number;
}

export interface PerformancePlan {
  planId: string;
  trigger: PerformerTrigger['kind'];
  intent: 'speak' | 'wait' | 'ignore' | 'react_nonverbally';
  behavior?: PerformanceBehavior;
  preReaction?: {
    leadBeforeSpeechMs: number;
    gaze?: {
      target: AttentionTarget;
      directness: number;
    };
    expression?: {
      emotion: Emotion;
      intensity: number;
    };
    motion?: {
      weight: number;
      headYawBias: number;
      };
  };
  motion?: {
    assetId: string;
  };
  timing: PerformanceTiming;
  speech?: {
    delayMs: number;
    llmContext: {
      callbackTendency: number;
      fragmentation: number;
      semanticBiases: string[];
    };
  };
  ttsProfile?: {
    rateScale: number;
    intonationScale: number;
  };
  avatarProfile?: {
    expressionHoldMs: number;
    gazeDirectness: number;
    idleMotionWeight: number;
    headYawBias: number;
  };
  activeDirectionIds: string[];
}

export interface PerformanceResult {
  planId: string;
  completedAt: number;
  outcome: 'completed' | 'cancelled' | 'interrupted' | 'failed';
  trigger: PerformerTrigger['kind'];
  intent: PerformancePlan['intent'];
  interactionAction?: VoiceInteractionAction;
  spokenText?: string;
  emotionCue?: {
    emotion: Emotion;
    intensity: number;
  };
  motionStartedAt?: number;
  speechStartedAt?: number;
  speechEndedAt?: number;
}

export interface LiveDirectionContext {
  trigger: PerformerTrigger;
  now: number;
}

export interface LiveDirection {
  id: string;
  contribute(context: LiveDirectionContext): DirectionContribution;
}
