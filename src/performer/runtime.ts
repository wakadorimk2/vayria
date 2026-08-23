import { normalizeEmotion } from '../character/emotion.js';
import { DEFAULT_PERFORMER_PROFILE } from './profile.js';
import type {
  ActionIntent,
  AttentionTarget,
  ConversationAction,
  ConversationActionDecision,
  DirectionContribution,
  DirectionEffect,
  DirectionModifiers,
  PerformancePlan,
  PerformanceResult,
  PerformerProfile,
  PerformerState,
  PerformerTrigger,
} from './types.js';

const MIN_EFFECT_INTENSITY = 0.001;
const MAX_SEMANTIC_BIASES = 12;
export const DEFAULT_SPEECH_MOTION_ASSET_ID = 'speech-gentle';
let planSequence = 0;

const PHATIC_ONLY_MESSAGES = new Set([
  'うん',
  'うんうん',
  'はい',
  'はいはい',
  'ええ',
  'そう',
  'そうそう',
  'そうだね',
  'そうなんだ',
  'そうか',
  'なるほど',
  'なるほどね',
  'そっか',
  'あの',
  'えっと',
  'えーと',
  'その',
  'まあ',
  'んー',
  'うーん',
  'あー',
  'ね',
  'あ',
]);
const PARTICIPATION_ONLY_MESSAGES = new Set(['ねえ', 'ちょっと']);
const UNFINISHED_ENDING =
  /(?:けど|けれど|けれども|ですが|なので|だから|から|ので|し|っていうか|というか|なんていうか)$/u;
const TERMINAL_PUNCTUATION = /[。．.!！?？、,，…\s]+$/u;
const ELLIPSIS_ENDING = /(?:…|\.{3,})$/u;
const ACTION_COMMITMENT_STEM =
  /(?:確認|整理|共有|作成|準備|開始|始め|進め|まとめ|説明|紹介|提示|検討|検証|実行|対応|話し|答え|決め|選び|見せ|聞き|調べ|考え|続け|取り組み)/u;
const ACTION_COMMITMENT_ENDING =
  /(?:していきましょう|していきます|しましょう|します|ましょう|ます)(?:ね|よ)?$/u;
const ACTION_COMMITMENT_CLAUSE_PATTERN = new RegExp(
  `^[^。．.!！?？]{0,72}${ACTION_COMMITMENT_STEM.source}[^。．.!！?？]{0,32}${ACTION_COMMITMENT_ENDING.source}[。．.!！?？]?$`,
  'u',
);
const META_ONLY_GENERIC_RESPONSE_PATTERN =
  /^(?:お願いします|了解(?:しました)?|承知しました|わかりました|そうしましょう|その方向で(?:進めましょう)?|この方向で(?:進めましょう)?|では(?:始めましょう)?|それでは(?:始めましょう)?|確認しましょう|整理しましょう|共有します)[。．.!！?？]?$/u;

function normalizeConversationText(message: string): string {
  return message.normalize('NFKC').replace(/\s+/gu, '').trim();
}

function splitConversationClauses(message: string): string[] {
  return message.split(/[。．.!！?？…、,，]+/u).filter(Boolean);
}

function createActionDecision(
  action: ConversationAction,
  backchannelCue: ConversationActionDecision['backchannelCue'] = 'none',
): ConversationActionDecision {
  return { action, backchannelCue };
}

export function isDefiniteQuestionMessage(message: string): boolean {
  return /[?？]/u.test(normalizeConversationText(message));
}

export function isDefiniteUnfinishedMessage(message: string): boolean {
  const normalized = normalizeConversationText(message);
  if (!normalized || isDefiniteQuestionMessage(normalized)) return false;
  if (ELLIPSIS_ENDING.test(normalized)) return true;
  const withoutTerminalPunctuation = normalized.replace(
    TERMINAL_PUNCTUATION,
    '',
  );
  return UNFINISHED_ENDING.test(withoutTerminalPunctuation);
}

export function isDefiniteBackchannelMessage(message: string): boolean {
  const normalized = normalizeConversationText(message);
  if (!normalized || isDefiniteQuestionMessage(normalized)) return false;
  if (ELLIPSIS_ENDING.test(normalized)) return false;
  const withoutTerminalPunctuation = normalized.replace(
    TERMINAL_PUNCTUATION,
    '',
  );
  return PHATIC_ONLY_MESSAGES.has(withoutTerminalPunctuation);
}

export function isDefiniteParticipationMessage(message: string): boolean {
  const normalized = normalizeConversationText(message);
  if (!normalized || isDefiniteQuestionMessage(normalized)) return false;
  if (ELLIPSIS_ENDING.test(normalized)) return false;
  const withoutTerminalPunctuation = normalized.replace(
    TERMINAL_PUNCTUATION,
    '',
  );
  return PARTICIPATION_ONLY_MESSAGES.has(withoutTerminalPunctuation);
}

export function isContentBearingVoiceMessage(message: string): boolean {
  const normalized = normalizeConversationText(message);
  return Boolean(
    normalized &&
      !isDefiniteBackchannelMessage(normalized) &&
      !isDefiniteUnfinishedMessage(normalized),
  );
}

export function isActionCommitmentMessage(message: string): boolean {
  const normalized = normalizeConversationText(message);
  if (!normalized || isDefiniteQuestionMessage(normalized)) return false;
  return splitConversationClauses(normalized).some((clause) =>
    ACTION_COMMITMENT_CLAUSE_PATTERN.test(clause),
  );
}

export function isMetaOnlyActionResponse(message: string): boolean {
  const normalized = normalizeConversationText(message);
  if (!normalized || isDefiniteQuestionMessage(normalized)) return false;
  const clauses = splitConversationClauses(normalized);
  return Boolean(
    clauses.length > 0 &&
      clauses.every(
        (clause) =>
          META_ONLY_GENERIC_RESPONSE_PATTERN.test(clause) ||
          ACTION_COMMITMENT_CLAUSE_PATTERN.test(clause) ||
          isDefiniteBackchannelMessage(clause),
      ),
  );
}

export function classifyViewerMessageFastPath(
  message: string,
): ConversationActionDecision | null {
  if (isDefiniteQuestionMessage(message)) {
    return createActionDecision('take_floor');
  }
  if (isDefiniteUnfinishedMessage(message)) {
    return createActionDecision('listen');
  }
  if (isDefiniteParticipationMessage(message)) {
    return createActionDecision('take_floor');
  }
  if (isDefiniteBackchannelMessage(message)) {
    return createActionDecision('silence');
  }
  return null;
}

function actionToPerformanceIntent(
  decision: ConversationActionDecision,
): ActionIntent['preferredIntent'] {
  switch (decision.action) {
    case 'take_floor':
      return 'speak';
    case 'react_nonverbally':
      return 'react_nonverbally';
    case 'listen':
    case 'backchannel':
    case 'wait':
    case 'silence':
      return 'wait';
  }
}

export function classifyFastPathAction(
  trigger: PerformerTrigger,
  state: PerformerState,
  profile: PerformerProfile = DEFAULT_PERFORMER_PROFILE,
  random = Math.random,
): ConversationActionDecision | null {
  switch (trigger.kind) {
    case 'viewer_message':
      return classifyViewerMessageFastPath(trigger.text);
    case 'external_stimulus':
      return createActionDecision('react_nonverbally');
    case 'memory_callback':
      return createActionDecision('take_floor');
    case 'idle_tick': {
      const initiative = clamp(profile.initiativeBaseline);
      const energyFactor = 0.55 + state.energy * 0.45;
      const speakChance = clamp(0.16 + initiative * 0.62 * energyFactor);
      const roll = random();
      return createActionDecision(
        roll < speakChance
          ? 'take_floor'
          : roll < speakChance + 0.18
            ? 'react_nonverbally'
            : 'wait',
      );
    }
  }
}

export function clamp(value: number, minimum = 0, maximum = 1): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(value, maximum));
}

export function createInitialPerformerState(
  now = Date.now(),
  profile: PerformerProfile = DEFAULT_PERFORMER_PROFILE,
): PerformerState {
  return {
    phase: 'idle',
    energy: clamp(profile.energyBaseline),
    emotion: {
      value: 'neutral',
      activation: 0,
      updatedAt: now,
    },
    attention: {
      target: 'none',
      strength: 0,
      updatedAt: now,
    },
    lastSpeechAt: null,
    lastViewerMessageAt: null,
  };
}

function decayTowardsZero(
  value: number,
  elapsedMs: number,
  halfLifeMs: number,
): number {
  if (elapsedMs <= 0 || halfLifeMs <= 0) return value;
  return value * Math.pow(0.5, elapsedMs / halfLifeMs);
}

export function decayPerformerState(
  state: PerformerState,
  now: number,
  profile: PerformerProfile = DEFAULT_PERFORMER_PROFILE,
): PerformerState {
  const emotionElapsed = Math.max(0, now - state.emotion.updatedAt);
  const attentionElapsed = Math.max(0, now - state.attention.updatedAt);
  const emotionActivation = clamp(
    decayTowardsZero(
      state.emotion.activation,
      emotionElapsed,
      profile.emotionDecayHalfLifeMs,
    ),
  );
  const attentionStrength = clamp(
    decayTowardsZero(
      state.attention.strength,
      attentionElapsed,
      profile.attentionDecayHalfLifeMs,
    ),
  );

  return {
    ...state,
    energy: clamp(
      state.energy +
        (profile.energyBaseline - state.energy) *
          (1 - Math.pow(0.5, Math.max(0, now - state.emotion.updatedAt) / 30_000)),
    ),
    emotion: {
      value: emotionActivation < 0.08 ? 'neutral' : state.emotion.value,
      activation: emotionActivation,
      updatedAt: now,
    },
    attention: {
      target: attentionStrength < 0.08 ? 'none' : state.attention.target,
      strength: attentionStrength,
      updatedAt: now,
    },
  };
}

function updateStateForTrigger(
  state: PerformerState,
  trigger: PerformerTrigger,
  now: number,
): PerformerState {
  switch (trigger.kind) {
    case 'viewer_message':
      return {
        ...state,
        attention: { target: 'viewer', strength: 1, updatedAt: now },
        lastViewerMessageAt: now,
      };
    case 'external_stimulus':
    case 'memory_callback':
      return trigger.kind === 'memory_callback'
        ? {
            ...state,
            attention: { target: 'chat', strength: 0.55, updatedAt: now },
          }
        : state;
    case 'idle_tick':
      return state;
  }
}

function baseSpeechContext(profile: PerformerProfile) {
  return {
    callbackTendency: clamp(profile.callbackTendencyBaseline),
    fragmentation: clamp(profile.fragmentationBaseline),
    semanticBiases: [] as string[],
  };
}

export function createActionIntent(
  trigger: PerformerTrigger,
  state: PerformerState,
  profile: PerformerProfile = DEFAULT_PERFORMER_PROFILE,
  random = Math.random,
): ActionIntent {
  const speechContext = baseSpeechContext(profile);
  const attentionTarget = state.attention.target;
  const actionDecision = classifyFastPathAction(
    trigger,
    state,
    profile,
    random,
  );

  switch (trigger.kind) {
    case 'viewer_message':
      return {
        trigger: trigger.kind,
        preferredIntent: actionDecision
          ? actionToPerformanceIntent(actionDecision)
          : 'speak',
        ...(actionDecision ? { actionDecision } : {}),
        attentionTarget: 'viewer',
        speechContext,
      };
    case 'external_stimulus':
      return {
        trigger: trigger.kind,
        preferredIntent: actionDecision
          ? actionToPerformanceIntent(actionDecision)
          : 'react_nonverbally',
        ...(actionDecision ? { actionDecision } : {}),
        attentionTarget,
        speechContext,
      };
    case 'memory_callback':
      return {
        trigger: trigger.kind,
        preferredIntent: actionDecision
          ? actionToPerformanceIntent(actionDecision)
          : 'speak',
        ...(actionDecision ? { actionDecision } : {}),
        attentionTarget: 'chat',
        speechContext,
    };
    case 'idle_tick': {
      return {
        trigger: trigger.kind,
        preferredIntent: actionDecision
          ? actionToPerformanceIntent(actionDecision)
          : 'wait',
        ...(actionDecision ? { actionDecision } : {}),
        attentionTarget: attentionTarget === 'none' ? 'viewer' : attentionTarget,
        speechContext,
      };
    }
  }
}

export function getEffectIntensity(effect: DirectionEffect, now: number): number {
  const elapsed = Math.max(0, now - effect.startedAt);
  if (effect.durationMs === undefined || effect.decay === 'none') {
    return clamp(effect.intensity);
  }
  if (elapsed >= effect.durationMs) return 0;

  const progress = elapsed / effect.durationMs;
  if (effect.decay === 'linear') {
    return clamp(effect.intensity * (1 - progress));
  }
  return clamp(effect.intensity * Math.pow(0.05, progress));
}

function createEmptyModifiers(): DirectionModifiers {
  return {
    responseDelayMs: 0,
    initiative: 0,
    emotionalInertia: 0,
    speechFragmentation: 0,
    callbackTendency: 0,
    gazeDirectness: 0,
    attentionStrength: 0,
    energy: 0,
    ttsRateScale: 0,
    ttsIntonationScale: 0,
    idleMotionWeight: 0,
    headYawBias: 0,
    semanticBiases: [],
  };
}

export interface AggregatedDirectionState {
  modifiers: DirectionModifiers;
  constraints: DirectionContribution['constraints'];
  semanticCues: string[];
  activeDirectionIds: string[];
  attentionTarget: AttentionTarget | null;
  planOverrides?: DirectionContribution['planOverrides'];
}

export function aggregateDirectionContributions(
  contributions: readonly DirectionContribution[],
  now: number,
): AggregatedDirectionState {
  const modifiers = createEmptyModifiers();
  const constraints: DirectionContribution['constraints'] = [];
  const semanticCues = new Set<string>();
  const activeDirectionIds = new Set<string>();
  const sortedContributions = [...contributions].sort((left, right) =>
    left.directionId.localeCompare(right.directionId),
  );
  const planOverrides = sortedContributions
    .map((contribution) => contribution.planOverrides)
    .find((candidate) => candidate !== undefined);

  for (const contribution of sortedContributions) {
    for (const constraint of contribution.constraints) {
      if (
        !constraints.some(
          (candidate) =>
            candidate.kind === constraint.kind &&
            candidate.scope === constraint.scope,
        )
      ) {
        constraints.push(constraint);
      }
    }
    for (const cue of contribution.semanticCues) {
      if (cue.trim()) semanticCues.add(cue.trim());
    }
    const sortedEffects = [...contribution.effects].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    for (const effect of sortedEffects) {
      const intensity = getEffectIntensity(effect, now);
      if (intensity < MIN_EFFECT_INTENSITY) continue;
      activeDirectionIds.add(effect.directionId);
      for (const key of Object.keys(modifiers) as Array<keyof DirectionModifiers>) {
        if (key === 'semanticBiases') continue;
        const value = effect.modifiers[key];
        if (typeof value === 'number') {
          modifiers[key] += value * intensity;
        }
      }
      for (const cue of effect.modifiers.semanticBiases ?? []) {
        if (cue.trim()) semanticCues.add(cue.trim());
      }
    }
  }

  const attentionTarget = sortedContributions
    .filter((contribution) => contribution.attentionTarget !== undefined)
    .map((contribution) => contribution.attentionTarget as AttentionTarget)
    .sort((left, right) => left.localeCompare(right))[0] ?? null;
  const sortedSemanticCues = [...semanticCues].sort();

  return {
    modifiers: {
      ...modifiers,
      semanticBiases: sortedSemanticCues.slice(0, MAX_SEMANTIC_BIASES),
    },
    constraints: [...constraints].sort((left, right) =>
      `${left.kind}:${left.scope}`.localeCompare(`${right.kind}:${right.scope}`),
    ),
    semanticCues: sortedSemanticCues.slice(0, MAX_SEMANTIC_BIASES),
    activeDirectionIds: [...activeDirectionIds].sort(),
    attentionTarget,
    planOverrides,
  };
}

export function applyPlanLocalModifiers(
  state: PerformerState,
  modifiers: DirectionModifiers,
): PerformerState {
  return {
    ...state,
    energy: clamp(state.energy + modifiers.energy),
  };
}

export function schedulePerformancePlan(
  state: PerformerState,
  plan: PerformancePlan,
): PerformerState {
  return {
    ...state,
    phase:
      plan.intent === 'speak' || plan.intent === 'react_nonverbally'
        ? 'scheduled'
        : 'waiting',
  };
}

export function applyDirectionModifiers(
  profile: PerformerProfile,
  modifiers: DirectionModifiers,
): PerformerProfile {
  return {
    ...profile,
    initiativeBaseline: clamp(profile.initiativeBaseline + modifiers.initiative),
    emotionalInertia: clamp(profile.emotionalInertia + modifiers.emotionalInertia),
    fragmentationBaseline: clamp(
      profile.fragmentationBaseline + modifiers.speechFragmentation,
    ),
    callbackTendencyBaseline: clamp(
      profile.callbackTendencyBaseline + modifiers.callbackTendency,
    ),
    gazeDirectnessBaseline: clamp(
      profile.gazeDirectnessBaseline + modifiers.gazeDirectness,
    ),
    responseDelayBaselineMs: clamp(
      profile.responseDelayBaselineMs + modifiers.responseDelayMs,
      0,
      2_000,
    ),
  };
}

function getAttentionTarget(
  target: ActionIntent['attentionTarget'],
): AttentionTarget {
  return target;
}

function createPlanId(): string {
  planSequence += 1;
  return `performer-plan-${Date.now()}-${planSequence}`;
}

export function resolvePerformancePlan(
  intent: ActionIntent,
  contributions: readonly DirectionContribution[],
  state: PerformerState,
  profile: PerformerProfile = DEFAULT_PERFORMER_PROFILE,
  now = Date.now(),
): PerformancePlan {
  const aggregate = aggregateDirectionContributions(contributions, now);
  const effectiveProfile = applyDirectionModifiers(profile, aggregate.modifiers);
  const requiresSpeech = aggregate.constraints.some(
    (constraint) =>
      constraint.kind === 'require_speech' && constraint.scope === 'current_plan',
  );
  let resolvedActionDecision = intent.actionDecision;
  let resolvedIntent = intent.preferredIntent;
  if (resolvedActionDecision) {
    resolvedIntent = actionToPerformanceIntent(resolvedActionDecision);
  }
  if (requiresSpeech && resolvedIntent !== 'speak') {
    resolvedIntent = 'speak';
    resolvedActionDecision = createActionDecision('take_floor');
  }
  const directness = clamp(
    effectiveProfile.gazeDirectnessBaseline + aggregate.modifiers.attentionStrength,
  );
  const attentionTarget =
    aggregate.attentionTarget ?? getAttentionTarget(intent.attentionTarget);
  const planId = createPlanId();
  const activeDirectionIds = aggregate.activeDirectionIds;
  const motion = aggregate.planOverrides
    ? aggregate.planOverrides.motion
    : resolvedIntent === 'speak'
      ? { assetId: DEFAULT_SPEECH_MOTION_ASSET_ID }
      : undefined;
  const preReaction =
    resolvedIntent === 'speak' || resolvedIntent === 'react_nonverbally'
      ? {
          leadBeforeSpeechMs: Math.round(
            clamp(effectiveProfile.leadBeforeSpeechMs, 0, 1_000),
          ),
          gaze: {
            target: attentionTarget,
            directness,
          },
          motion: {
            weight: clamp(1 + aggregate.modifiers.idleMotionWeight),
            headYawBias: Math.max(
              -12,
              Math.min(12, aggregate.modifiers.headYawBias),
            ),
          },
        }
      : undefined;

  return {
    planId,
    trigger: intent.trigger,
    intent: resolvedIntent,
    ...(resolvedActionDecision
      ? { actionDecision: resolvedActionDecision }
      : {}),
    ...(aggregate.planOverrides?.behavior
      ? { behavior: aggregate.planOverrides.behavior }
      : {}),
    preReaction,
    speech:
      resolvedIntent === 'speak'
        ? {
            delayMs: Math.round(
              clamp(effectiveProfile.responseDelayBaselineMs, 0, 2_000),
            ),
            llmContext: {
              callbackTendency: clamp(
                effectiveProfile.callbackTendencyBaseline,
              ),
              fragmentation: clamp(effectiveProfile.fragmentationBaseline),
              semanticBiases: [
                ...new Set([
                  ...intent.speechContext.semanticBiases,
                  ...aggregate.semanticCues,
                ]),
              ]
                .sort()
                .slice(0, MAX_SEMANTIC_BIASES),
            },
          }
        : undefined,
    ttsProfile:
      resolvedIntent === 'speak'
        ? {
            rateScale: clamp(1 + aggregate.modifiers.ttsRateScale, 0.65, 1.35),
            intonationScale: clamp(
              1 + aggregate.modifiers.ttsIntonationScale,
              0.5,
              1.5,
            ),
          }
        : undefined,
    motion,
    timing: {
      motionLeadMs: Math.round(
        clamp(effectiveProfile.motionLeadMs, 0, 300),
      ),
      motionEnterBlendMs: Math.round(
        clamp(effectiveProfile.motionEnterBlendMs, 0, 1_000),
      ),
      motionExitBlendMs: Math.round(
        clamp(effectiveProfile.motionExitBlendMs, 0, 1_000),
      ),
      motionPreparationTimeoutMs: Math.round(
        clamp(effectiveProfile.motionPreparationTimeoutMs, 0, 1_500),
      ),
      postSpeechHoldMs: Math.round(
        clamp(effectiveProfile.postSpeechHoldMs, 0, 2_000),
      ),
    },
    avatarProfile: {
      expressionHoldMs: 800,
      gazeDirectness: directness,
      idleMotionWeight: clamp(1 + aggregate.modifiers.idleMotionWeight),
      headYawBias: Math.max(-12, Math.min(12, aggregate.modifiers.headYawBias)),
    },
    activeDirectionIds,
  };
}

export function applyTriggerToState(
  state: PerformerState,
  trigger: PerformerTrigger,
  now = Date.now(),
  profile: PerformerProfile = DEFAULT_PERFORMER_PROFILE,
): PerformerState {
  return updateStateForTrigger(
    decayPerformerState(state, now, profile),
    trigger,
    now,
  );
}

export function reducePerformanceResult(
  previousState: PerformerState,
  result: PerformanceResult,
  profile: PerformerProfile = DEFAULT_PERFORMER_PROFILE,
): PerformerState {
  const nextState = decayPerformerState(previousState, result.completedAt, profile);
  if (result.outcome === 'failed') {
    return { ...nextState, phase: 'idle' };
  }

  if (result.outcome !== 'completed') {
    return { ...nextState, phase: 'idle' };
  }

  let emotion = nextState.emotion;
  if (result.emotionCue) {
    const cueIntensity = clamp(result.emotionCue.intensity);
    const inertia = clamp(profile.emotionalInertia);
    const retainedActivation = nextState.emotion.activation * inertia;
    const activation = clamp(
      retainedActivation + cueIntensity * (1 - inertia),
    );
    const keepPreviousEmotion =
      result.emotionCue.emotion === 'neutral' &&
      nextState.emotion.activation > 0.18 &&
      inertia > 0.45;
    emotion = {
      value: keepPreviousEmotion
        ? nextState.emotion.value
        : normalizeEmotion(result.emotionCue.emotion),
      activation,
      updatedAt: result.completedAt,
    };
  }

  const lastSpeechAt = result.spokenText
    ? result.speechEndedAt ?? result.completedAt
    : nextState.lastSpeechAt;
  const energyDelta = result.spokenText
    ? result.trigger === 'idle_tick'
      ? -0.055
      : -0.025
    : 0;

  return {
    ...nextState,
    phase: 'idle',
    energy: clamp(nextState.energy + energyDelta),
    emotion,
    lastSpeechAt,
  };
}

export function getNextAutonomousDelay(
  state: PerformerState,
  profile: PerformerProfile = DEFAULT_PERFORMER_PROFILE,
  isFirstTick: boolean,
  random = Math.random,
): number {
  if (isFirstTick) {
    return Math.round(profile.autonomousInitialDelayMs);
  }

  const base =
    profile.autonomousMinDelayMs +
    random() * (profile.autonomousMaxDelayMs - profile.autonomousMinDelayMs);
  const initiativeFactor = 1.35 - clamp(profile.initiativeBaseline) * 0.7;
  return Math.round(
    Math.max(profile.autonomousMinDelayMs, base * initiativeFactor),
  );
}

export { DEFAULT_PERFORMER_PROFILE };
