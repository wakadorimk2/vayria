import type { Emotion } from '../character/emotion.js';

export const CONVERSATION_ACTIONS = [
  'take_floor',
  'listen',
  'backchannel',
  'react_nonverbally',
  'wait',
  'silence',
] as const;

export type ConversationAction = (typeof CONVERSATION_ACTIONS)[number];

export const CONVERSATION_BACKCHANNEL_CUES = ['none', 'un', 'uun'] as const;

export type ConversationBackchannelCue =
  (typeof CONVERSATION_BACKCHANNEL_CUES)[number];

export interface ConversationActionDecision {
  action: ConversationAction;
  backchannelCue: ConversationBackchannelCue;
}

export function isConversationAction(
  value: unknown,
): value is ConversationAction {
  return (
    typeof value === 'string' &&
    (CONVERSATION_ACTIONS as readonly string[]).includes(value)
  );
}

export function isConversationBackchannelCue(
  value: unknown,
): value is ConversationBackchannelCue {
  return (
    typeof value === 'string' &&
    (CONVERSATION_BACKCHANNEL_CUES as readonly string[]).includes(value)
  );
}

export function isConversationActionDecision(
  value: unknown,
): value is ConversationActionDecision {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).some(
      (key) => key !== 'action' && key !== 'backchannelCue',
    )
  ) {
    return false;
  }
  if (!isConversationAction(record.action)) return false;
  if (!isConversationBackchannelCue(record.backchannelCue)) return false;

  return (
    (record.action === 'backchannel' && record.backchannelCue !== 'none') ||
    (record.action !== 'backchannel' && record.backchannelCue === 'none')
  );
}

export const ATTENTION_TARGETS = ['viewer', 'chat', 'game', 'none'] as const;

export type AttentionTarget = (typeof ATTENTION_TARGETS)[number];

export const SPATIAL_TARGET_KINDS = ['viewer', 'game', 'chat'] as const;

export type SpatialTargetKind = (typeof SPATIAL_TARGET_KINDS)[number];

export const SPATIAL_TARGET_ANCHORS = ['default', 'transient'] as const;

export type SpatialTargetAnchor = (typeof SPATIAL_TARGET_ANCHORS)[number];

export interface SpatialTargetSelection {
  kind: SpatialTargetKind;
  anchor: SpatialTargetAnchor;
}

export const ATTENTION_FOCUS_TARGETS = [
  'user',
  'camera',
  'screen',
  'idle',
  'other_person',
] as const;

export type AttentionFocusTarget = (typeof ATTENTION_FOCUS_TARGETS)[number];

export const ATTENTION_PHASES = [
  'focused',
  'holding',
  'uncertain',
  'released',
  'reengaging',
] as const;

export type AttentionPhase = (typeof ATTENTION_PHASES)[number];

export interface AttentionFocus {
  target: AttentionFocusTarget;
  phase: AttentionPhase;
  confidence: number;
}

export interface AttentionPosition {
  x: number;
  y: number;
}

export interface Attention {
  target: AttentionTarget;
  strength: number;
  updatedAt: number;
  position: AttentionPosition | null;
  confidence: number;
  distance?: number;
  gaze?: AttentionPosition;
  spatialTarget?: SpatialTargetSelection;
}

export type AttentionReader = () => Attention;

export type ExternalStimulusMetadata = Readonly<Record<string, string>>;

export const PERFORMER_PHASES = [
  'idle',
  'scheduled',
  'waiting',
  'synthesizing',
  'speaking',
  'cooldown',
  'error',
] as const;

export type PerformerPhase = (typeof PERFORMER_PHASES)[number];

export type PerformerTrigger =
  | {
      kind: 'viewer_message';
      text: string;
    }
  | {
      kind: 'autonomous_candidate';
      episodeId: string;
      reasonIds: readonly string[];
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
  attention: Attention;
  lastSpeechAt: number | null;
  lastViewerMessageAt: number | null;
}

export interface PerformerStateContext {
  phase: PerformerPhase;
  energy: number;
  emotion: Emotion;
  emotionActivation: number;
  attentionTarget: AttentionTarget;
  attentionStrength: number;
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
  initialAutonomyDelayMs: number;
  autonomyQuietTimeMinMs: number;
  autonomyQuietTimeMaxMs: number;
  leadBeforeSpeechMs: number;
  motionLeadMs: number;
  motionEnterBlendMs: number;
  motionExitBlendMs: number;
  motionPreparationTimeoutMs: number;
  postSpeechHoldMs: number;
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
  planOverrides?: {
    behavior?: PerformanceBehavior;
    motion?: {
      assetId: string;
    };
  };
}

export interface ActionIntent {
  trigger: PerformerTrigger['kind'];
  preferredIntent: 'speak' | 'wait' | 'ignore' | 'react_nonverbally';
  actionDecision?: ConversationActionDecision;
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
  actionDecision?: ConversationActionDecision;
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
  interactionAction?: ConversationAction;
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
