import type { Emotion } from '../character/emotion';

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
      source: 'wildcard' | 'game' | 'tip' | 'system';
      semanticCue: string;
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
    target: 'viewer' | 'chat' | 'game' | 'none';
    strength: number;
    updatedAt: number;
  };
  currentTopic: string | null;
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
  preReactionDelayMs: number;
  autonomousInitialDelayMs: number;
  autonomousMinDelayMs: number;
  autonomousMaxDelayMs: number;
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
}

export interface ActionIntent {
  trigger: PerformerTrigger['kind'];
  preferredIntent: 'speak' | 'wait' | 'ignore' | 'react_nonverbally';
  attentionTarget: 'viewer' | 'chat' | 'game' | 'none';
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

export interface PerformancePlan {
  planId: string;
  trigger: PerformerTrigger['kind'];
  intent: 'speak' | 'wait' | 'ignore' | 'react_nonverbally';
  preReaction?: {
    delayMs: number;
    gaze?: {
      target: 'viewer' | 'chat' | 'none';
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
  spokenText?: string;
  emotionCue?: {
    emotion: Emotion;
    intensity: number;
  };
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
