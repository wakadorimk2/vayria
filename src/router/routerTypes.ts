export const ROUTER_CONTROL_STATES = [
  'idle',
  'human_override',
  'interrupting',
  'cooldown',
] as const;

export type RouterControlState = (typeof ROUTER_CONTROL_STATES)[number];

export const ROUTER_LANES = ['idle', 'listening', 'speaking'] as const;
export type RouterLane = (typeof ROUTER_LANES)[number];

export const ROUTER_ORIGINS = [
  'vayria',
  'gpt',
  'human',
  'environment',
] as const;
export type RouterOrigin = (typeof ROUTER_ORIGINS)[number];

export const ROUTER_KINDS = [
  'speech',
  'backchannel',
  'noise',
  'control',
] as const;
export type RouterKind = (typeof ROUTER_KINDS)[number];

export const ROUTER_GATES = ['open', 'closed'] as const;
export type RouterGate = (typeof ROUTER_GATES)[number];

export const ROUTER_CASE_IDS = [
  'voice_listener_reaction',
  'interruption',
  'continuity_variation',
] as const;
export type RouterCaseId = (typeof ROUTER_CASE_IDS)[number];

export function isRouterCaseId(value: unknown): value is RouterCaseId {
  return (
    typeof value === 'string' &&
    (ROUTER_CASE_IDS as readonly string[]).includes(value)
  );
}

export interface RouterMetrics {
  turnCount: number;
  stateTransitionErrors: number;
  falseInterruptions: number;
  confirmedInterruptions: number;
  interruptionLatencyMs: number | null;
  backchannelRepetitions: number;
  gateBlockedCount: number;
  cooldownMs: number;
}

export interface RouterSnapshot {
  sessionId: string;
  caseId: RouterCaseId | null;
  caseActive: boolean;
  controlState: RouterControlState;
  vayriaLane: RouterLane;
  gptLane: RouterLane;
  gptInputGate: RouterGate;
  vayriaOutputGate: RouterGate;
  lastDecision: RouterDecision | null;
  lastReason: string | null;
  cooldownUntil: number | null;
  startedAt: number;
  updatedAt: number;
  metrics: RouterMetrics;
  lastSpeechStartedAt: number | null;
  lastBackchannelAt: number | null;
  cooldownStartedAt: number | null;
}

export type RouterCommand =
  | { type: 'take_floor' }
  | { type: 'stop_vayria' }
  | { type: 'stop_gpt_lane' }
  | { type: 'let_continue' }
  | { type: 'reset' }
  | { type: 'case_start'; caseId: RouterCaseId }
  | { type: 'case_finish' };

export type RouterSignal =
  | {
      type: 'vayria_status';
      status: 'idle' | 'thinking' | 'synthesizing' | 'speaking' | 'error';
      voiceInputEnabled: boolean;
    }
  | {
      type: 'voice_input';
      event:
        | 'listening_started'
        | 'speech_started'
        | 'speech_ended'
        | 'utterance_finalized'
        | 'recognition_stopped'
        | 'recognition_failed';
    }
  | {
      type: 'gpt_status';
      lane: RouterLane;
    }
  | {
      type: 'gpt_audio';
      event: 'speech_started' | 'speech_ended' | 'backchannel';
    }
  | {
      type: 'interaction_action';
      action: 'listen' | 'backchannel' | 'react_nonverbally' | 'take_floor';
      backchannelCue?: 'un' | 'uun';
    }
  | {
      type: 'barge_in_decision';
      accepted: boolean;
      latencyMs?: number | null;
    }
  | { type: 'tick' };

export type RouterInput =
  | { type: 'command'; command: RouterCommand; at?: number }
  | { type: 'signal'; signal: RouterSignal; at?: number };

export type RouterEffect =
  | { type: 'interrupt_vayria' }
  | { type: 'set_autonomous_enabled'; enabled: boolean }
  | { type: 'set_gpt_input_gate'; gate: RouterGate }
  | { type: 'set_vayria_output_gate'; gate: RouterGate }
  | { type: 'reset_vayria' };

export type RouterEventName =
  | 'state_observed'
  | 'control_applied'
  | 'case_started'
  | 'case_finished'
  | 'gate_blocked'
  | 'transition_error';

export type RouterDecision =
  | 'observe'
  | 'take_floor'
  | 'stop_vayria'
  | 'stop_gpt_lane'
  | 'let_continue'
  | 'reset'
  | 'case_start'
  | 'case_finish'
  | 'cooldown_complete'
  | 'turn_observed'
  | 'confirmed_interrupt'
  | 'false_interrupt'
  | 'backchannel_observed'
  | 'gpt_lane_observed'
  | 'vayria_lane_observed'
  | 'gate_blocked'
  | 'transition_error'
  | 'noop';

export const ROUTER_DECISIONS = [
  'observe',
  'take_floor',
  'stop_vayria',
  'stop_gpt_lane',
  'let_continue',
  'reset',
  'case_start',
  'case_finish',
  'cooldown_complete',
  'turn_observed',
  'confirmed_interrupt',
  'false_interrupt',
  'backchannel_observed',
  'gpt_lane_observed',
  'vayria_lane_observed',
  'gate_blocked',
  'transition_error',
  'noop',
] as const;

export function isRouterDecision(value: unknown): value is RouterDecision {
  return (
    typeof value === 'string' &&
    (ROUTER_DECISIONS as readonly string[]).includes(value)
  );
}

export function isRouterReason(value: unknown): value is string {
  if (typeof value !== 'string' || value.length > 120) return false;
  return (
    [
      'human_take_floor',
      'human_stop_vayria',
      'gpt_audio_to_vayria_gate_closed',
      'resume_after_cooldown',
      'router_reset',
      'evaluation_case_started',
      'evaluation_case_finished',
      'cooldown_not_complete',
      'autonomous_processing_resumed',
      'backchannel_observed',
      'backchannel_repeated_in_window',
      'barge_in_confirmed_without_transcript',
      'barge_in_rejected_without_transcript',
      'gpt_audio_blocked_before_vayria_input',
      'case_id_invalid',
      'case_not_active',
    ].includes(value) ||
    /^vayria_status_(idle|thinking|synthesizing|speaking|error)$/.test(value) ||
    /^human_voice_(listening_started|speech_started|speech_ended|utterance_finalized|recognition_stopped|recognition_failed)$/.test(
      value,
    ) ||
    /^gpt_lane_(idle|listening|speaking)$/.test(value) ||
    /^gpt_audio_(speech_started|speech_ended|backchannel)$/.test(value) ||
    /^vayria_action_(listen|backchannel|react_nonverbally|take_floor)$/.test(
      value,
    )
  );
}

export interface RouterEvent {
  event: RouterEventName;
  timestamp: string;
  sessionId: string;
  caseId: RouterCaseId | null;
  origin: RouterOrigin;
  kind: RouterKind;
  controlState: RouterControlState;
  vayriaLane: RouterLane;
  gptLane: RouterLane;
  gptInputGate: RouterGate;
  vayriaOutputGate: RouterGate;
  decision: RouterDecision;
  reason: string;
  latencyMs: number | null;
  metrics: RouterMetrics;
}

export interface RouterTransition {
  snapshot: RouterSnapshot;
  effects: RouterEffect[];
  event: RouterEvent;
}
