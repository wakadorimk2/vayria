import {
  isRouterCaseId,
  type RouterCommand,
  type RouterDecision,
  type RouterEffect,
  type RouterEvent,
  type RouterEventName,
  type RouterInput,
  type RouterKind,
  type RouterOrigin,
  type RouterSignal,
  type RouterSnapshot,
  type RouterTransition,
  type RouterLane,
} from './routerTypes.js';

export const ROUTER_COOLDOWN_MS = 500;
const BACKCHANNEL_REPEAT_WINDOW_MS = 2_000;
const MAX_REASON_LENGTH = 120;

function clampLatency(value: number | null | undefined): number | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.max(0, Math.min(Math.round(value), 60_000));
}

function normalizeAt(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function createMetrics(): RouterSnapshot['metrics'] {
  return {
    turnCount: 0,
    stateTransitionErrors: 0,
    falseInterruptions: 0,
    confirmedInterruptions: 0,
    interruptionLatencyMs: null,
    backchannelRepetitions: 0,
    gateBlockedCount: 0,
    cooldownMs: 0,
  };
}

export function createRouterSessionId(): string {
  const randomPart = Math.floor(Math.random() * 0x1000000)
    .toString(36)
    .padStart(5, '0');
  return `rt-${Date.now().toString(36)}-${randomPart}`;
}

export function createInitialRouterSnapshot(
  sessionId = createRouterSessionId(),
  at = Date.now(),
): RouterSnapshot {
  return {
    sessionId,
    caseId: null,
    caseActive: false,
    controlState: 'idle',
    vayriaLane: 'idle',
    gptLane: 'idle',
    gptInputGate: 'open',
    vayriaOutputGate: 'open',
    lastDecision: null,
    lastReason: null,
    cooldownUntil: null,
    startedAt: at,
    updatedAt: at,
    metrics: createMetrics(),
    lastSpeechStartedAt: null,
    lastBackchannelAt: null,
    cooldownStartedAt: null,
  };
}

function increment(
  metrics: RouterSnapshot['metrics'],
  key: keyof Pick<
    RouterSnapshot['metrics'],
    | 'turnCount'
    | 'stateTransitionErrors'
    | 'falseInterruptions'
    | 'confirmedInterruptions'
    | 'backchannelRepetitions'
    | 'gateBlockedCount'
  >,
): RouterSnapshot['metrics'] {
  return { ...metrics, [key]: metrics[key] + 1 };
}

function eventKindForSignal(signal: RouterSignal): RouterKind {
  switch (signal.type) {
    case 'gpt_audio':
      return signal.event === 'backchannel' ? 'backchannel' : 'speech';
    case 'voice_input':
      return signal.event === 'speech_started' ||
        signal.event === 'speech_ended' ||
        signal.event === 'utterance_finalized'
        ? 'speech'
        : 'control';
    case 'interaction_action':
      return signal.action === 'backchannel' ? 'backchannel' : 'control';
    case 'gpt_status':
    case 'vayria_status':
    case 'barge_in_decision':
    case 'tick':
      return 'control';
  }
}

function makeEvent(
  snapshot: RouterSnapshot,
  at: number,
  details: {
    event: RouterEventName;
    origin: RouterOrigin;
    kind: RouterKind;
    decision: RouterDecision;
    reason: string;
    latencyMs?: number | null;
  },
): RouterEvent {
  return {
    event: details.event,
    timestamp: new Date(at).toISOString(),
    sessionId: snapshot.sessionId,
    caseId: snapshot.caseId,
    origin: details.origin,
    kind: details.kind,
    controlState: snapshot.controlState,
    vayriaLane: snapshot.vayriaLane,
    gptLane: snapshot.gptLane,
    gptInputGate: snapshot.gptInputGate,
    vayriaOutputGate: snapshot.vayriaOutputGate,
    decision: details.decision,
    reason: details.reason.slice(0, MAX_REASON_LENGTH),
    latencyMs: clampLatency(details.latencyMs),
    metrics: { ...snapshot.metrics },
  };
}

function finishTransition(
  snapshot: RouterSnapshot,
  at: number,
  details: Parameters<typeof makeEvent>[2],
  effects: RouterEffect[] = [],
): RouterTransition {
  const nextSnapshot = {
    ...snapshot,
    updatedAt: at,
    lastDecision: details.decision,
    lastReason: details.reason.slice(0, MAX_REASON_LENGTH),
  };
  return {
    snapshot: nextSnapshot,
    effects,
    event: makeEvent(nextSnapshot, at, details),
  };
}

function errorTransition(
  snapshot: RouterSnapshot,
  at: number,
  reason: string,
): RouterTransition {
  const nextSnapshot = {
    ...snapshot,
    updatedAt: at,
    lastDecision: 'transition_error' as const,
    lastReason: reason,
    metrics: increment(snapshot.metrics, 'stateTransitionErrors'),
  };
  return {
    snapshot: nextSnapshot,
    effects: [],
    event: makeEvent(nextSnapshot, at, {
      event: 'transition_error',
      origin: 'environment',
      kind: 'control',
      decision: 'transition_error',
      reason,
    }),
  };
}

function reduceCommand(
  snapshot: RouterSnapshot,
  command: RouterCommand,
  at: number,
): RouterTransition {
  switch (command.type) {
    case 'take_floor': {
      const nextSnapshot = {
        ...snapshot,
        controlState: 'human_override' as const,
        gptInputGate: 'closed' as const,
        vayriaOutputGate: 'open' as const,
        cooldownUntil: null,
        cooldownStartedAt: null,
      };
      return finishTransition(
        nextSnapshot,
        at,
        {
          event: 'control_applied',
          origin: 'human',
          kind: 'control',
          decision: 'take_floor',
          reason: 'human_take_floor',
        },
        [
          { type: 'interrupt_vayria' },
          { type: 'set_autonomous_enabled', enabled: false },
          { type: 'set_gpt_input_gate', gate: 'closed' },
        ],
      );
    }
    case 'stop_vayria': {
      const nextSnapshot = {
        ...snapshot,
        controlState: 'interrupting' as const,
        vayriaLane: 'idle' as const,
        vayriaOutputGate: 'closed' as const,
        cooldownUntil: null,
        cooldownStartedAt: null,
      };
      return finishTransition(
        nextSnapshot,
        at,
        {
          event: 'control_applied',
          origin: 'human',
          kind: 'control',
          decision: 'stop_vayria',
          reason: 'human_stop_vayria',
        },
        [
          { type: 'interrupt_vayria' },
          { type: 'set_autonomous_enabled', enabled: false },
          { type: 'set_vayria_output_gate', gate: 'closed' },
        ],
      );
    }
    case 'stop_gpt_lane': {
      const nextSnapshot = {
        ...snapshot,
        gptInputGate: 'closed' as const,
      };
      return finishTransition(
        nextSnapshot,
        at,
        {
          event: 'control_applied',
          origin: 'human',
          kind: 'control',
          decision: 'stop_gpt_lane',
          reason: 'gpt_audio_to_vayria_gate_closed',
        },
        [{ type: 'set_gpt_input_gate', gate: 'closed' }],
      );
    }
    case 'let_continue': {
      const nextSnapshot = {
        ...snapshot,
        controlState: 'cooldown' as const,
        gptInputGate: 'open' as const,
        vayriaOutputGate: 'open' as const,
        cooldownUntil: at + ROUTER_COOLDOWN_MS,
        cooldownStartedAt: at,
      };
      return finishTransition(
        nextSnapshot,
        at,
        {
          event: 'control_applied',
          origin: 'human',
          kind: 'control',
          decision: 'let_continue',
          reason: 'resume_after_cooldown',
        },
        [
          { type: 'set_gpt_input_gate', gate: 'open' },
          { type: 'set_vayria_output_gate', gate: 'open' },
          { type: 'set_autonomous_enabled', enabled: false },
        ],
      );
    }
    case 'reset': {
      const nextSnapshot = createInitialRouterSnapshot(snapshot.sessionId, at);
      return finishTransition(
        nextSnapshot,
        at,
        {
          event: 'control_applied',
          origin: 'human',
          kind: 'control',
          decision: 'reset',
          reason: 'router_reset',
        },
        [
          { type: 'reset_vayria' },
          { type: 'set_gpt_input_gate', gate: 'open' },
          { type: 'set_vayria_output_gate', gate: 'open' },
          { type: 'set_autonomous_enabled', enabled: true },
        ],
      );
    }
    case 'case_start': {
      if (!isRouterCaseId(command.caseId)) {
        return errorTransition(snapshot, at, 'case_id_invalid');
      }
      const nextSnapshot = {
        ...createInitialRouterSnapshot(snapshot.sessionId, at),
        caseId: command.caseId,
        caseActive: true,
      };
      return finishTransition(nextSnapshot, at, {
        event: 'case_started',
        origin: 'human',
        kind: 'control',
        decision: 'case_start',
        reason: 'evaluation_case_started',
      });
    }
    case 'case_finish': {
      if (!snapshot.caseActive || snapshot.caseId === null) {
        return errorTransition(snapshot, at, 'case_not_active');
      }
      const nextSnapshot = {
        ...snapshot,
        caseActive: false,
        controlState: 'idle' as const,
        gptInputGate: 'open' as const,
        vayriaOutputGate: 'open' as const,
        cooldownUntil: null,
        cooldownStartedAt: null,
      };
      return finishTransition(
        nextSnapshot,
        at,
        {
          event: 'case_finished',
          origin: 'human',
          kind: 'control',
          decision: 'case_finish',
          reason: 'evaluation_case_finished',
        },
        [
          { type: 'set_gpt_input_gate', gate: 'open' },
          { type: 'set_vayria_output_gate', gate: 'open' },
          { type: 'set_autonomous_enabled', enabled: true },
        ],
      );
    }
  }
}

function reduceSignal(
  snapshot: RouterSnapshot,
  signal: RouterSignal,
  at: number,
): RouterTransition {
  switch (signal.type) {
    case 'vayria_status': {
      const vayriaLane: RouterLane =
        signal.status === 'speaking'
          ? 'speaking'
          : signal.voiceInputEnabled
            ? 'listening'
            : 'idle';
      const nextSnapshot = { ...snapshot, vayriaLane };
      return finishTransition(nextSnapshot, at, {
        event: 'state_observed',
        origin: 'vayria',
        kind: 'control',
        decision: 'vayria_lane_observed',
        reason: `vayria_status_${signal.status}`,
      });
    }
    case 'voice_input': {
      if (signal.event === 'utterance_finalized') {
        const latencyMs = clampLatency(
          snapshot.lastSpeechStartedAt === null
            ? null
            : at - snapshot.lastSpeechStartedAt,
        );
        const nextSnapshot = {
          ...snapshot,
          metrics: increment(snapshot.metrics, 'turnCount'),
        };
        return finishTransition(nextSnapshot, at, {
          event: 'state_observed',
          origin: 'human',
          kind: 'speech',
          decision: 'turn_observed',
          reason: 'human_utterance_finalized',
          latencyMs,
        });
      }
      const nextSnapshot =
        signal.event === 'speech_started'
          ? { ...snapshot, lastSpeechStartedAt: at }
          : snapshot;
      return finishTransition(nextSnapshot, at, {
        event: 'state_observed',
        origin: 'human',
        kind: eventKindForSignal(signal),
        decision: 'observe',
        reason: `human_voice_${signal.event}`,
      });
    }
    case 'gpt_status': {
      const nextSnapshot: RouterSnapshot = {
        ...snapshot,
        gptLane: signal.lane,
      };
      return finishTransition(nextSnapshot, at, {
        event: 'state_observed',
        origin: 'gpt',
        kind: 'control',
        decision: 'gpt_lane_observed',
        reason: `gpt_lane_${signal.lane}`,
      });
    }
    case 'gpt_audio': {
      if (snapshot.gptInputGate === 'closed') {
        const nextSnapshot: RouterSnapshot = {
          ...snapshot,
          gptLane: signal.event === 'speech_ended' ? 'idle' : 'speaking',
          metrics: increment(snapshot.metrics, 'gateBlockedCount'),
        };
        return finishTransition(nextSnapshot, at, {
          event: 'gate_blocked',
          origin: 'gpt',
          kind: eventKindForSignal(signal),
          decision: 'gate_blocked',
          reason: 'gpt_audio_blocked_before_vayria_input',
        });
      }
      const nextSnapshot: RouterSnapshot = {
        ...snapshot,
        gptLane: signal.event === 'speech_ended' ? 'idle' : 'speaking',
      };
      return finishTransition(nextSnapshot, at, {
        event: 'state_observed',
        origin: 'gpt',
        kind: eventKindForSignal(signal),
        decision: 'gpt_lane_observed',
        reason: `gpt_audio_${signal.event}`,
      });
    }
    case 'interaction_action': {
      if (signal.action !== 'backchannel') {
        return finishTransition(snapshot, at, {
          event: 'state_observed',
          origin: 'vayria',
          kind: 'control',
          decision: 'observe',
          reason: `vayria_action_${signal.action}`,
        });
      }
      const isRepeat =
        snapshot.lastBackchannelAt !== null &&
        at - snapshot.lastBackchannelAt <= BACKCHANNEL_REPEAT_WINDOW_MS;
      const nextSnapshot = {
        ...snapshot,
        lastBackchannelAt: at,
        metrics: isRepeat
          ? increment(snapshot.metrics, 'backchannelRepetitions')
          : snapshot.metrics,
      };
      return finishTransition(nextSnapshot, at, {
        event: 'state_observed',
        origin: 'vayria',
        kind: 'backchannel',
        decision: 'backchannel_observed',
        reason: isRepeat
          ? 'backchannel_repeated_in_window'
          : 'backchannel_observed',
      });
    }
    case 'barge_in_decision': {
      const latencyMs = clampLatency(
        signal.latencyMs ??
          (snapshot.lastSpeechStartedAt === null
            ? null
            : at - snapshot.lastSpeechStartedAt),
      );
      const nextSnapshot = {
        ...snapshot,
        lastSpeechStartedAt: null,
        metrics: {
          ...snapshot.metrics,
          ...(signal.accepted
            ? {
                confirmedInterruptions:
                  snapshot.metrics.confirmedInterruptions + 1,
              }
            : {
                falseInterruptions: snapshot.metrics.falseInterruptions + 1,
              }),
          interruptionLatencyMs: latencyMs,
        },
      };
      return finishTransition(nextSnapshot, at, {
        event: 'state_observed',
        origin: 'human',
        kind: 'control',
        decision: signal.accepted ? 'confirmed_interrupt' : 'false_interrupt',
        reason: signal.accepted
          ? 'barge_in_confirmed_without_transcript'
          : 'barge_in_rejected_without_transcript',
        latencyMs,
      });
    }
    case 'tick': {
      if (
        snapshot.controlState !== 'cooldown' ||
        snapshot.cooldownUntil === null ||
        at < snapshot.cooldownUntil
      ) {
        return finishTransition(snapshot, at, {
          event: 'state_observed',
          origin: 'environment',
          kind: 'control',
          decision: 'noop',
          reason: 'cooldown_not_complete',
        });
      }
      const cooldownMs =
        snapshot.cooldownStartedAt === null
          ? 0
          : Math.max(0, at - snapshot.cooldownStartedAt);
      const nextSnapshot = {
        ...snapshot,
        controlState: 'idle' as const,
        cooldownUntil: null,
        cooldownStartedAt: null,
        metrics: {
          ...snapshot.metrics,
          cooldownMs: snapshot.metrics.cooldownMs + cooldownMs,
        },
      };
      return finishTransition(
        nextSnapshot,
        at,
        {
          event: 'state_observed',
          origin: 'environment',
          kind: 'control',
          decision: 'cooldown_complete',
          reason: 'autonomous_processing_resumed',
        },
        [{ type: 'set_autonomous_enabled', enabled: true }],
      );
    }
  }
}

export function reduceRouter(
  snapshot: RouterSnapshot,
  input: RouterInput,
  now = Date.now(),
): RouterTransition {
  const at = normalizeAt(input.at, normalizeAt(now, snapshot.updatedAt));
  if (input.type === 'command') {
    return reduceCommand(snapshot, input.command, at);
  }
  return reduceSignal(snapshot, input.signal, at);
}

export interface ConversationRouter {
  dispatch(command: RouterCommand, at?: number): RouterTransition;
  observe(signal: RouterSignal, at?: number): RouterTransition;
  tick(at?: number): RouterTransition;
  getSnapshot(): RouterSnapshot;
  subscribe(listener: (snapshot: RouterSnapshot) => void): () => void;
}

export function createConversationRouter(options: {
  sessionId?: string;
  now?: number;
  onEvent?: (event: RouterEvent) => void;
} = {}): ConversationRouter {
  let snapshot = createInitialRouterSnapshot(
    options.sessionId ?? createRouterSessionId(),
    options.now ?? Date.now(),
  );
  const listeners = new Set<(snapshot: RouterSnapshot) => void>();

  const apply = (input: RouterInput, at?: number): RouterTransition => {
    const transition = reduceRouter(snapshot, { ...input, at });
    snapshot = transition.snapshot;
    options.onEvent?.(transition.event);
    for (const listener of listeners) listener(snapshot);
    return transition;
  };

  return {
    dispatch(command, at) {
      return apply({ type: 'command', command }, at);
    },
    observe(signal, at) {
      return apply({ type: 'signal', signal }, at);
    },
    tick(at) {
      return apply({ type: 'signal', signal: { type: 'tick' } }, at);
    },
    getSnapshot() {
      return snapshot;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
