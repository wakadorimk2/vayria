import { normalizeEmotion } from '../character/emotion.js';
import { DEFAULT_PERFORMER_PROFILE } from './profile.js';
import type {
  ActionIntent,
  AttentionTarget,
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
let planSequence = 0;

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

  switch (trigger.kind) {
    case 'viewer_message':
      return {
        trigger: trigger.kind,
        preferredIntent: 'speak',
        attentionTarget: 'viewer',
        speechContext,
      };
    case 'external_stimulus':
      return {
        trigger: trigger.kind,
        preferredIntent: 'react_nonverbally',
        attentionTarget,
        speechContext,
      };
    case 'memory_callback':
      return {
        trigger: trigger.kind,
        preferredIntent: 'speak',
        attentionTarget: 'chat',
        speechContext,
      };
    case 'idle_tick': {
      const initiative = clamp(profile.initiativeBaseline);
      const energyFactor = 0.55 + state.energy * 0.45;
      const speakChance = clamp(0.16 + initiative * 0.62 * energyFactor);
      const roll = random();
      return {
        trigger: trigger.kind,
        preferredIntent:
          roll < speakChance
            ? 'speak'
            : roll < speakChance + 0.18
              ? 'react_nonverbally'
              : 'ignore',
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
  const resolvedIntent =
    requiresSpeech && intent.preferredIntent !== 'speak'
      ? 'speak'
      : intent.preferredIntent;
  const directness = clamp(
    effectiveProfile.gazeDirectnessBaseline + aggregate.modifiers.attentionStrength,
  );
  const attentionTarget =
    aggregate.attentionTarget ?? getAttentionTarget(intent.attentionTarget);
  const planId = createPlanId();
  const activeDirectionIds = aggregate.activeDirectionIds;
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
