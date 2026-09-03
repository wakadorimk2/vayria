import type { PerformerProfile } from '../performer/types.js';

export const AUTONOMY_TURN_GATE_PHASES = [
  'initial_quiet',
  'ready',
  'running',
  'refractory',
  'waiting_candidate',
] as const;

export type AutonomyTurnGatePhase =
  (typeof AUTONOMY_TURN_GATE_PHASES)[number];

export const AUTONOMY_TIMING_MODES = ['baseline', 'monotonic'] as const;

export type AutonomyTimingMode = (typeof AUTONOMY_TIMING_MODES)[number];

export const DEFAULT_AUTONOMY_TIMING_MODE: AutonomyTimingMode = 'monotonic';

function parseAutonomyTimingMode(value: unknown): AutonomyTimingMode | null {
  return typeof value === 'string' &&
    (AUTONOMY_TIMING_MODES as readonly string[]).includes(value)
    ? (value as AutonomyTimingMode)
    : null;
}

export function readAutonomyTimingMode(value: unknown): AutonomyTimingMode {
  return parseAutonomyTimingMode(value) ?? DEFAULT_AUTONOMY_TIMING_MODE;
}

export function resolveAutonomyTimingMode(
  queryValue: unknown,
  environmentValue: unknown,
): AutonomyTimingMode {
  return (
    parseAutonomyTimingMode(queryValue) ??
    parseAutonomyTimingMode(environmentValue) ??
    DEFAULT_AUTONOMY_TIMING_MODE
  );
}

export const AUTONOMY_TURN_GATE_EXTERNAL_EVENTS = [
  'viewer_speech',
  'card_change',
  'router_change',
] as const;

export type AutonomyTurnGateExternalEvent =
  (typeof AUTONOMY_TURN_GATE_EXTERNAL_EVENTS)[number];

export const AUTONOMY_TURN_GATE_BLOCK_REASONS = [
  'initial_quiet',
  'refractory',
  'running',
  'busy',
  'voice_activity',
  'loop_disabled',
  'muted',
  'not_ready',
  'hidden',
  'no_candidate',
] as const;

export type AutonomyTurnGateBlockReason =
  (typeof AUTONOMY_TURN_GATE_BLOCK_REASONS)[number];

export const AUTONOMY_TURN_GATE_EVENTS = [
  'session_reset',
  'candidate_selected',
  'gate_blocked',
  'gate_passed',
  'turn_started',
  'turn_completed',
  'turn_aborted',
  'external_event',
  'timer_ready',
  'turn_result',
  'internal_delta',
  'opportunity_skipped',
] as const;

export type AutonomyTurnGateEvent =
  (typeof AUTONOMY_TURN_GATE_EVENTS)[number];

export const AUTONOMY_TURN_GATE_TRANSITIONS = [
  'blocked',
  'passed',
  'entered_running',
  'entered_refractory',
  'reopened',
  'restarted',
  'timer_expired',
  'ignored',
] as const;

export type AutonomyTurnGateTransition =
  (typeof AUTONOMY_TURN_GATE_TRANSITIONS)[number];

export interface AutonomyTurnGateTiming {
  initialAutonomyDelayMs: number;
  autonomyQuietTimeMinMs: number;
  autonomyQuietTimeMaxMs: number;
}

export interface AutonomyTurnGateState {
  phase: AutonomyTurnGatePhase;
  nextEligibleAt: number | null;
  quietStartedAt: number | null;
  readinessThreshold: number | null;
  reopenAfterTurn: boolean;
}

export interface AutonomyTimingSnapshot {
  elapsedSilenceMs: number;
  readiness: number;
  threshold: number | null;
}

export interface AutonomyTurnGateTelemetry {
  gateEvent: AutonomyTurnGateEvent;
  gatePhase: AutonomyTurnGatePhase;
  transition?: AutonomyTurnGateTransition;
  blockedBy?: AutonomyTurnGateBlockReason;
  externalEvent?: AutonomyTurnGateExternalEvent;
  candidateEpisodeId?: string;
  candidateReasonIds?: readonly string[];
  candidateEvidenceIds?: readonly string[];
  usedReasonIds?: readonly string[];
  internalDeltaOperations?: readonly string[];
  affectedReasonIds?: readonly string[];
  createdReasonIds?: readonly string[];
  resolvedReasonIds?: readonly string[];
  externalAction?: 'speak' | 'none';
  nextEligibleAt?: number | null;
  delayMs?: number;
  timingMode?: AutonomyTimingMode;
  elapsedSilenceMs?: number;
  readiness?: number;
  threshold?: number;
  opportunityOutcome?: 'fired' | 'skipped';
  sessionGeneration?: number;
}

export type AutonomyTurnGateAction =
  | { type: 'reset'; at?: number }
  | { type: 'timer_expired'; at?: number }
  | {
      type: 'external_event';
      event: AutonomyTurnGateExternalEvent;
      at?: number;
    }
  | { type: 'turn_started'; at?: number }
  | { type: 'turn_completed'; at?: number }
  | { type: 'turn_aborted'; at?: number }
  | { type: 'opportunity_skipped'; at?: number }
  | { type: 'candidate_available'; at?: number };

function readTimingValue(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function readTiming(timing: AutonomyTurnGateTiming): AutonomyTurnGateTiming {
  const min = readTimingValue(timing.autonomyQuietTimeMinMs);
  const max = Math.max(min, readTimingValue(timing.autonomyQuietTimeMaxMs));
  return {
    initialAutonomyDelayMs: readTimingValue(timing.initialAutonomyDelayMs),
    autonomyQuietTimeMinMs: min,
    autonomyQuietTimeMaxMs: max,
  };
}

export function readAutonomyTurnGateTiming(
  profile: Pick<
    PerformerProfile,
    | 'initialAutonomyDelayMs'
    | 'autonomyQuietTimeMinMs'
    | 'autonomyQuietTimeMaxMs'
  >,
): AutonomyTurnGateTiming {
  return readTiming(profile);
}

export function createAutonomyTurnGateState(
  now = Date.now(),
  timing: AutonomyTurnGateTiming,
): AutonomyTurnGateState {
  const normalizedTiming = readTiming(timing);
  const nextEligibleAt =
    normalizedTiming.initialAutonomyDelayMs > 0
      ? now + normalizedTiming.initialAutonomyDelayMs
      : null;
  return {
    phase: nextEligibleAt === null ? 'ready' : 'initial_quiet',
    nextEligibleAt,
    quietStartedAt: null,
    readinessThreshold: null,
    reopenAfterTurn: false,
  };
}

function sampleReadinessThreshold(random: () => number): number {
  const sampledRandom = random();
  const randomValue = Number.isFinite(sampledRandom) ? sampledRandom : 0;
  return Math.min(1, Math.max(0, randomValue));
}

export function sampleAutonomyQuietTime(
  timing: AutonomyTurnGateTiming,
  random = Math.random,
): number {
  const normalizedTiming = readTiming(timing);
  const sampledRandom = random();
  const randomValue = Number.isFinite(sampledRandom) ? sampledRandom : 0;
  const boundedRandom = Math.min(1, Math.max(0, randomValue));
  return Math.min(
    normalizedTiming.autonomyQuietTimeMaxMs,
    normalizedTiming.autonomyQuietTimeMinMs +
      Math.floor(
        boundedRandom *
          (normalizedTiming.autonomyQuietTimeMaxMs -
            normalizedTiming.autonomyQuietTimeMinMs +
            1),
      ),
  );
}

function createRefractoryState(
  at: number,
  timing: AutonomyTurnGateTiming,
  random: () => number,
  mode: AutonomyTimingMode,
): AutonomyTurnGateState {
  if (mode === 'baseline') {
    const quietTimeMs = sampleAutonomyQuietTime(timing, random);
    return {
      phase: quietTimeMs === 0 ? 'ready' : 'refractory',
      nextEligibleAt: quietTimeMs === 0 ? null : at + quietTimeMs,
      quietStartedAt: null,
      readinessThreshold: null,
      reopenAfterTurn: false,
    };
  }

  const normalizedTiming = readTiming(timing);
  const threshold = sampleReadinessThreshold(random);
  const readinessDelayMs = Math.ceil(
    normalizedTiming.autonomyQuietTimeMinMs +
      Math.sqrt(threshold) *
        (normalizedTiming.autonomyQuietTimeMaxMs -
          normalizedTiming.autonomyQuietTimeMinMs),
  );
  return {
    phase: readinessDelayMs === 0 ? 'ready' : 'refractory',
    nextEligibleAt: readinessDelayMs === 0 ? null : at + readinessDelayMs,
    quietStartedAt: at,
    readinessThreshold: threshold,
    reopenAfterTurn: false,
  };
}

export function readAutonomyTimingSnapshot(
  state: AutonomyTurnGateState,
  timing: AutonomyTurnGateTiming,
  now = Date.now(),
  mode: AutonomyTimingMode = 'baseline',
): AutonomyTimingSnapshot {
  if (
    mode !== 'monotonic' ||
    state.quietStartedAt === null ||
    state.readinessThreshold === null
  ) {
    return {
      elapsedSilenceMs: 0,
      readiness: state.phase === 'ready' ? 1 : 0,
      threshold: null,
    };
  }

  const normalizedTiming = readTiming(timing);
  const elapsedSilenceMs = Math.max(0, now - state.quietStartedAt);
  const windowMs =
    normalizedTiming.autonomyQuietTimeMaxMs -
    normalizedTiming.autonomyQuietTimeMinMs;
  const normalizedElapsed =
    windowMs === 0
      ? elapsedSilenceMs >= normalizedTiming.autonomyQuietTimeMinMs
        ? 1
        : 0
      : Math.min(
          1,
          Math.max(
            0,
            (elapsedSilenceMs - normalizedTiming.autonomyQuietTimeMinMs) /
              windowMs,
          ),
        );
  return {
    elapsedSilenceMs,
    readiness: normalizedElapsed * normalizedElapsed,
    threshold: state.readinessThreshold,
  };
}

export function transitionAutonomyTurnGate(
  current: AutonomyTurnGateState,
  action: AutonomyTurnGateAction,
  timing: AutonomyTurnGateTiming,
  random = Math.random,
  mode: AutonomyTimingMode = 'baseline',
): AutonomyTurnGateState {
  const at = action.at ?? Date.now();

  if (action.type === 'reset') {
    return createAutonomyTurnGateState(at, timing);
  }

  if (action.type === 'timer_expired') {
    if (
      (current.phase !== 'initial_quiet' && current.phase !== 'refractory') ||
      current.nextEligibleAt === null ||
      at < current.nextEligibleAt
    ) {
      return current;
    }
    return {
      phase: 'ready',
      nextEligibleAt: null,
      quietStartedAt: current.quietStartedAt,
      readinessThreshold: current.readinessThreshold,
      reopenAfterTurn: false,
    };
  }

  if (action.type === 'external_event') {
    if (
      mode === 'monotonic' &&
      action.event === 'viewer_speech' &&
      (current.phase === 'ready' || current.phase === 'refractory')
    ) {
      return createRefractoryState(at, timing, random, mode);
    }
    if (current.phase === 'waiting_candidate') {
      return createRefractoryState(at, timing, random, mode);
    }
    if (current.phase === 'refractory') {
      return {
        phase: 'ready',
        nextEligibleAt: null,
        quietStartedAt: null,
        readinessThreshold: null,
        reopenAfterTurn: false,
      };
    }
    if (current.phase === 'running') {
      return current.reopenAfterTurn
        ? current
        : { ...current, reopenAfterTurn: true };
    }
    return current;
  }

  if (action.type === 'turn_started') {
    if (current.phase !== 'ready') return current;
    return {
      phase: 'running',
      nextEligibleAt: null,
      quietStartedAt: null,
      readinessThreshold: null,
      reopenAfterTurn: false,
    };
  }

  if (action.type === 'turn_aborted') {
    if (current.phase !== 'running') return current;
    return {
      phase: 'ready',
      nextEligibleAt: null,
      quietStartedAt: null,
      readinessThreshold: null,
      reopenAfterTurn: false,
    };
  }

  if (action.type === 'opportunity_skipped') {
    if (current.phase !== 'ready') return current;
    if (mode === 'monotonic') {
      return {
        phase: 'waiting_candidate',
        nextEligibleAt: null,
        quietStartedAt: null,
        readinessThreshold: null,
        reopenAfterTurn: false,
      };
    }
    return createRefractoryState(at, timing, random, mode);
  }

  if (action.type === 'candidate_available') {
    if (current.phase !== 'waiting_candidate') return current;
    return createRefractoryState(at, timing, random, mode);
  }

  if (current.phase !== 'running') return current;
  if (current.reopenAfterTurn) {
    return {
      phase: 'ready',
      nextEligibleAt: null,
      quietStartedAt: null,
      readinessThreshold: null,
      reopenAfterTurn: false,
    };
  }
  return createRefractoryState(at, timing, random, mode);
}

export function isAutonomyTurnGateReady(
  state: AutonomyTurnGateState,
): boolean {
  return state.phase === 'ready';
}

export function getAutonomyTurnGateWaitMs(
  state: AutonomyTurnGateState,
  now = Date.now(),
): number | null {
  if (state.nextEligibleAt === null) return null;
  return Math.max(0, state.nextEligibleAt - now);
}
