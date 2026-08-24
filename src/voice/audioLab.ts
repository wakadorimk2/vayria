import type { InteractionTimelineEvent } from '../conversation/interactionTimeline.js';
import type { VoiceInputEvent } from './voiceInput.js';

export const AUDIO_LAB_MODES = [
  'baseline',
  'processed',
  'processed-vad',
  'exhibition-mix',
] as const;

export type AudioLabMode = (typeof AUDIO_LAB_MODES)[number];

export const DEFAULT_AUDIO_INPUT_MODE: AudioLabMode = 'baseline';
export const DEFAULT_AUDIO_LAB_MODE: AudioLabMode = 'processed';
export const DEFAULT_VAD_THRESHOLD = 0.02;
export const DEFAULT_MILD_VAD_THRESHOLD = 0.015;
export const AUDIO_ENDPOINT_VALUES = [400, 600] as const;
export type AudioEndpointMs = (typeof AUDIO_ENDPOINT_VALUES)[number];
export const DEFAULT_AUDIO_ENDPOINT_MS: AudioEndpointMs = 600;
export const DEFAULT_EXHIBITION_MIX_ENDPOINT_MS: AudioEndpointMs = 400;

export function getEffectiveAudioEndpointMs(
  mode: AudioLabMode,
  configuredEndpointMs: AudioEndpointMs,
): AudioEndpointMs {
  if (mode === 'exhibition-mix') {
    return DEFAULT_EXHIBITION_MIX_ENDPOINT_MS;
  }
  if (mode === 'processed' || mode === 'processed-vad') {
    return configuredEndpointMs;
  }
  return DEFAULT_AUDIO_ENDPOINT_MS;
}

export const EXHIBITION_AUDIO_PRESETS = [
  'off',
  'mild',
  'aggressive',
] as const;

export type ExhibitionAudioPreset = (typeof EXHIBITION_AUDIO_PRESETS)[number];

export const DEFAULT_EXHIBITION_AUDIO_PRESET: ExhibitionAudioPreset = 'mild';
export const STT_MODEL_VALUES = ['tiny', 'base', 'small'] as const;
export type SttModel = (typeof STT_MODEL_VALUES)[number];
export const STT_DEVICE_VALUES = ['auto', 'cuda', 'cpu'] as const;
export type SttDevice = (typeof STT_DEVICE_VALUES)[number];
export const STT_COMPUTE_TYPE_VALUES = ['auto', 'float16', 'int8'] as const;
export type SttComputeType = (typeof STT_COMPUTE_TYPE_VALUES)[number];
export const VAD_THRESHOLD_MIN = 0.005;
export const VAD_THRESHOLD_MAX = 0.2;
export const VAD_THRESHOLD_STEP = 0.005;
export const ADAPTIVE_NOISE_FLOOR_INITIAL = 0.005;
export const ADAPTIVE_NOISE_FLOOR_ALPHA = 0.05;
export const ADAPTIVE_NOISE_FLOOR_MULTIPLIER = 2.5;
export const MILD_NOISE_FLOOR_MULTIPLIER = 2.0;
export const BARGE_IN_DUCK_GAIN = 0.25;
export const BARGE_IN_GAIN_RAMP_MS = 20;
export const BARGE_IN_TIMEOUT_MS = 2_500;

export const AUDIO_PROCESSING_CONSTRAINTS = [
  'echoCancellation',
  'noiseSuppression',
  'autoGainControl',
] as const;

export type AudioProcessingConstraint =
  (typeof AUDIO_PROCESSING_CONSTRAINTS)[number];

export type BargeInState = 'idle' | 'candidate' | 'confirmed' | 'restored';
export type BargeInAction = 'duck' | 'interrupt' | 'restore';

export const KNOWN_HALLUCINATION_PHRASES = [
  'ご視聴ありがとうございました',
  'ありがとうございました',
  'ご覧いただきありがとうございました',
] as const;

export type AudioLabRequestedConstraints = Partial<
  Record<AudioProcessingConstraint, boolean>
>;

export interface ExhibitionAudioPresetConfig {
  requestedConstraints: Required<
    Pick<AudioLabRequestedConstraints, AudioProcessingConstraint>
  >;
  browserGateEnabled: boolean;
  defaultVadThreshold: number;
  noiseFloorMultiplier: number;
}

export const EXHIBITION_AUDIO_PRESET_CONFIGS: Record<
  ExhibitionAudioPreset,
  ExhibitionAudioPresetConfig
> = {
  off: {
    requestedConstraints: {
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
    },
    browserGateEnabled: false,
    defaultVadThreshold: DEFAULT_VAD_THRESHOLD,
    noiseFloorMultiplier: ADAPTIVE_NOISE_FLOOR_MULTIPLIER,
  },
  mild: {
    requestedConstraints: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
    },
    browserGateEnabled: true,
    defaultVadThreshold: DEFAULT_MILD_VAD_THRESHOLD,
    noiseFloorMultiplier: MILD_NOISE_FLOOR_MULTIPLIER,
  },
  aggressive: {
    requestedConstraints: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
    },
    browserGateEnabled: true,
    defaultVadThreshold: 0.04,
    noiseFloorMultiplier: 3.0,
  },
};

export interface AudioLabAppliedMediaSettings {
  echoCancellation?: boolean | string;
  noiseSuppression?: boolean;
  autoGainControl?: boolean;
  sampleRate?: number;
  sampleSize?: number;
  channelCount?: number;
  latency?: number;
}

export interface AudioLabMediaSettings {
  requested: AudioLabRequestedConstraints;
  supported: Partial<Record<AudioProcessingConstraint, boolean>>;
  applied: AudioLabAppliedMediaSettings;
}

export type VoiceCaptureEngine = 'audio-worklet' | 'script-processor';
export type VoiceCaptureHealthStatus =
  | 'probing'
  | 'ready'
  | 'recovering'
  | 'failed';

export interface VoiceCaptureHealth {
  engine: VoiceCaptureEngine | null;
  audioContextState: 'running' | 'suspended' | 'closed' | 'unavailable';
  trackMuted: boolean | null;
  trackReadyState: 'live' | 'ended' | 'unavailable';
  pcmFrameCount: number;
  lastPcmAt: number | null;
  status: VoiceCaptureHealthStatus;
  errorCode: string | null;
}

export type VoiceInputDiagnostic =
  | {
      type: 'media_settings';
      at: number;
      settings: AudioLabMediaSettings;
    }
  | {
      type: 'audio_level';
      at: number;
      audioLevel: number;
      vadScore: number | null;
      vadSpeech: boolean;
      sentToStt: boolean;
      noiseFloor: number | null;
      effectiveThreshold: number | null;
      vadThreshold: number | null;
    }
  | {
      type: 'capture_health';
      at: number;
      health: VoiceCaptureHealth;
    }
  | {
      type: 'vad_rejected';
      at: number;
      candidateDurationMs: number;
      maxScore: number;
      reason: string;
      noiseFloor: number | null;
      effectiveThreshold: number | null;
      vadThreshold: number | null;
    }
  | {
      type: 'barge_in';
      at: number;
      action: BargeInAction;
      state: BargeInState;
      ttsPlaying: boolean;
      reason?: string;
    }
  | {
      type: 'stt_runtime';
      at: number;
      runtime: SttRuntimeInfo;
    }
  | {
      type: 'stt_queued';
      segmentId: string;
      at: number;
    }
  | {
      type: 'stt_started';
      segmentId: string;
      at: number;
    }
  | {
      type: 'stt_observed';
      segmentId: string;
      at: number;
      rawText: string;
      acceptedText: string;
      filterReason?: string;
    };

export interface SttRuntimeInfo {
  requestedModel: SttModel;
  requestedDevice: SttDevice;
  requestedComputeType: SttComputeType;
  effectiveModel: string;
  effectiveDevice: string;
  effectiveComputeType: string;
  fallbackUsed: boolean;
  fallbackReason: string | null;
  modelLoadMs: number | null;
}

export function isSttRuntimeInfo(value: unknown): value is SttRuntimeInfo {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    (STT_MODEL_VALUES as readonly string[]).includes(
      record.requestedModel as string,
    ) &&
    (STT_DEVICE_VALUES as readonly string[]).includes(
      record.requestedDevice as string,
    ) &&
    (STT_COMPUTE_TYPE_VALUES as readonly string[]).includes(
      record.requestedComputeType as string,
    ) &&
    typeof record.effectiveModel === 'string' &&
    typeof record.effectiveDevice === 'string' &&
    typeof record.effectiveComputeType === 'string' &&
    typeof record.fallbackUsed === 'boolean' &&
    (record.fallbackReason === null || typeof record.fallbackReason === 'string') &&
    (record.modelLoadMs === null ||
      (typeof record.modelLoadMs === 'number' &&
        Number.isFinite(record.modelLoadMs) &&
        record.modelLoadMs >= 0))
  );
}

export function isAudioLabMode(value: unknown): value is AudioLabMode {
  return (
    typeof value === 'string' &&
    (AUDIO_LAB_MODES as readonly string[]).includes(value)
  );
}

export function isExhibitionAudioPreset(
  value: unknown,
): value is ExhibitionAudioPreset {
  return (
    typeof value === 'string' &&
    (EXHIBITION_AUDIO_PRESETS as readonly string[]).includes(value)
  );
}

export function isAudioEndpointMs(value: unknown): value is AudioEndpointMs {
  return value === 400 || value === 600;
}

function parseAudioEndpointMs(value: unknown): AudioEndpointMs | null {
  if (isAudioEndpointMs(value)) return value;
  if (typeof value !== 'string') return null;
  const parsed = Number(value.trim());
  return isAudioEndpointMs(parsed) ? parsed : null;
}

export function resolveAudioEndpointMs(
  queryValue: unknown,
  environmentValue: unknown,
): AudioEndpointMs {
  return (
    parseAudioEndpointMs(queryValue) ??
    parseAudioEndpointMs(environmentValue) ??
    DEFAULT_AUDIO_ENDPOINT_MS
  );
}

export function resolveExhibitionAudioPreset(
  queryValue: unknown,
  environmentValue: unknown,
): ExhibitionAudioPreset {
  if (isExhibitionAudioPreset(queryValue)) return queryValue;
  if (isExhibitionAudioPreset(environmentValue)) return environmentValue;
  return DEFAULT_EXHIBITION_AUDIO_PRESET;
}

export function getExhibitionAudioPresetConfig(
  preset: ExhibitionAudioPreset,
): ExhibitionAudioPresetConfig {
  return EXHIBITION_AUDIO_PRESET_CONFIGS[preset];
}

export function resolveInitialAudioLabMode(
  audioLabEnabled: boolean,
  isExhibition = false,
): AudioLabMode {
  return audioLabEnabled || isExhibition
    ? DEFAULT_AUDIO_LAB_MODE
    : DEFAULT_AUDIO_INPUT_MODE;
}

export function clampVadThreshold(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_VAD_THRESHOLD;
  return Math.max(VAD_THRESHOLD_MIN, Math.min(value, VAD_THRESHOLD_MAX));
}

function normalizePhrase(value: string): string {
  return value
    .normalize('NFKC')
    .replace(/[\s。、．.!！?？…「」『』"'、,，]/g, '')
    .trim();
}

export function findKnownHallucinationPhrase(
  value: string,
): string | null {
  const normalized = normalizePhrase(value);
  if (!normalized) return null;

  return (
    KNOWN_HALLUCINATION_PHRASES.find(
      (phrase) => normalizePhrase(phrase) === normalized,
    ) ?? null
  );
}

export function sanitizeMediaTrackSettings(
  settings: unknown,
): AudioLabAppliedMediaSettings {
  if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
    return {};
  }
  const record = settings as Record<string, unknown>;

  return {
    ...(typeof record.echoCancellation === 'boolean' ||
    typeof record.echoCancellation === 'string'
      ? { echoCancellation: record.echoCancellation }
      : {}),
    ...(typeof record.noiseSuppression === 'boolean'
      ? { noiseSuppression: record.noiseSuppression }
      : {}),
    ...(typeof record.autoGainControl === 'boolean'
      ? { autoGainControl: record.autoGainControl }
      : {}),
    ...(typeof record.sampleRate === 'number'
      ? { sampleRate: record.sampleRate }
      : {}),
    ...(typeof record.sampleSize === 'number'
      ? { sampleSize: record.sampleSize }
      : {}),
    ...(typeof record.channelCount === 'number'
      ? { channelCount: record.channelCount }
      : {}),
    ...(typeof record.latency === 'number'
      ? { latency: record.latency }
      : {}),
  };
}

export interface VoiceLabModeSummary {
  utteranceCount: number;
  candidateCount: number;
  sttSuccessCount: number;
  vadRejectCount: number;
  noiseLikeSttCount: number;
  knownHallucinationCount: number;
  ttsOverlapCount: number;
  averageSttLatencyMs: number | null;
  bargeInTriggeredCount: number;
  bargeInConfirmedCount: number;
  bargeInRestoredCount: number;
  bargeInTimeoutCount: number;
  ttsActiveDurationMs: number;
  ttsCandidateCount: number;
  ttsAcceptedCount: number;
  ttsVadRejectCount: number;
  ttsNoiseLikeSttCount: number;
  ttsCandidatesPerMinute: number | null;
  averageSttQueueWaitMs?: number | null;
  averageSttProcessingMs?: number | null;
  averageEndpointToResultLatencyMs?: number | null;
  averageSpeechToResultLatencyMs?: number | null;
}

export interface VoiceLabSessionSummary extends VoiceLabModeSummary {
  byMode: Record<AudioLabMode, VoiceLabModeSummary>;
}

export interface VoiceLabSessionStartedRecord {
  kind: 'session_started';
  timestamp: string;
  sessionId: string;
  mode: AudioLabMode;
  preset: ExhibitionAudioPreset;
  audioEndpointMs?: AudioEndpointMs;
}

export interface VoiceLabModeChangedRecord {
  kind: 'mode_changed';
  timestamp: string;
  sessionId: string;
  mode: AudioLabMode;
  preset: ExhibitionAudioPreset;
  audioEndpointMs?: AudioEndpointMs;
}

export interface VoiceLabUtteranceRecord {
  kind: 'utterance';
  timestamp: string;
  sessionId: string;
  mode: AudioLabMode;
  preset: ExhibitionAudioPreset;
  audioEndpointMs?: AudioEndpointMs;
  segmentId: string | null;
  speechStartAt: string | null;
  speechEndAt: string | null;
  sttStartedAt: string | null;
  sttResultAt: string;
  sttLatencyMs: number | null;
  recognizedText: string;
  rawRecognizedText: string;
  audioDurationMs: number | null;
  maxVadScore?: number | null;
  vadThreshold?: number | null;
  effectiveThreshold?: number | null;
  noiseFloor?: number | null;
  vadAccepted: boolean | null;
  rejectReason: string | null;
  ttsPlayingDuringUtterance: boolean;
  mediaTrackSettings: AudioLabMediaSettings | null;
  knownHallucinationPhrase: string | null;
  error: string | null;
  sttQueuedAt?: string | null;
  sttObservedAt?: string | null;
  sttQueueWaitMs?: number | null;
  sttProcessingMs?: number | null;
  endpointToResultLatencyMs?: number | null;
  speechToResultLatencyMs?: number | null;
}

export interface VoiceLabSttRuntimeRecord {
  kind: 'stt_runtime';
  timestamp: string;
  sessionId: string;
  mode: AudioLabMode;
  preset: ExhibitionAudioPreset;
  audioEndpointMs?: AudioEndpointMs;
  runtime: SttRuntimeInfo;
}

export interface VoiceLabVadRejectedRecord {
  kind: 'vad_rejected';
  timestamp: string;
  sessionId: string;
  mode: AudioLabMode;
  preset: ExhibitionAudioPreset;
  audioEndpointMs?: AudioEndpointMs;
  speechStartAt: string | null;
  speechEndAt: string;
  audioDurationMs: number;
  vadAccepted: false;
  rejectReason: string;
  maxVadScore: number;
  vadThreshold?: number | null;
  effectiveThreshold?: number | null;
  noiseFloor?: number | null;
  ttsPlayingDuringUtterance: boolean;
  mediaTrackSettings: AudioLabMediaSettings | null;
}

export interface VoiceLabBargeInRecord {
  kind: 'barge_in';
  timestamp: string;
  sessionId: string;
  mode: AudioLabMode;
  preset: ExhibitionAudioPreset;
  audioEndpointMs?: AudioEndpointMs;
  action: BargeInAction;
  state: BargeInState;
  ttsPlaying: boolean;
  reason?: string;
}

export interface VoiceLabInteractionTimelineRecord {
  kind: 'interaction_timeline';
  timestamp: string;
  sessionId: string;
  mode: AudioLabMode;
  preset: ExhibitionAudioPreset;
  audioEndpointMs?: AudioEndpointMs;
  event: InteractionTimelineEvent;
}

export interface VoiceLabErrorRecord {
  kind: 'error';
  timestamp: string;
  sessionId: string;
  mode: AudioLabMode;
  preset: ExhibitionAudioPreset;
  audioEndpointMs?: AudioEndpointMs;
  error: string;
  segmentId: string | null;
}

export interface VoiceLabSessionSummaryRecord {
  kind: 'session_summary';
  timestamp: string;
  sessionId: string;
  preset: ExhibitionAudioPreset;
  audioEndpointMs?: AudioEndpointMs;
  summary: VoiceLabSessionSummary;
}

export type VoiceLabRecord =
  | VoiceLabSessionStartedRecord
  | VoiceLabModeChangedRecord
  | VoiceLabUtteranceRecord
  | VoiceLabVadRejectedRecord
  | VoiceLabBargeInRecord
  | VoiceLabInteractionTimelineRecord
  | VoiceLabErrorRecord
  | VoiceLabSttRuntimeRecord
  | VoiceLabSessionSummaryRecord;

export interface VoiceLabSnapshot {
  sessionId: string | null;
  records: VoiceLabRecord[];
  summary: VoiceLabSessionSummary;
  latestRecord: VoiceLabRecord | null;
  latestTranscript: string;
  latestError: string | null;
  sttRuntime: SttRuntimeInfo | null;
}

export function createEmptyModeSummary(): VoiceLabModeSummary {
  return {
    utteranceCount: 0,
    candidateCount: 0,
    sttSuccessCount: 0,
    vadRejectCount: 0,
    noiseLikeSttCount: 0,
    knownHallucinationCount: 0,
    ttsOverlapCount: 0,
    averageSttLatencyMs: null,
    bargeInTriggeredCount: 0,
    bargeInConfirmedCount: 0,
    bargeInRestoredCount: 0,
    bargeInTimeoutCount: 0,
    ttsActiveDurationMs: 0,
    ttsCandidateCount: 0,
    ttsAcceptedCount: 0,
    ttsVadRejectCount: 0,
    ttsNoiseLikeSttCount: 0,
    ttsCandidatesPerMinute: null,
    averageSttQueueWaitMs: null,
    averageSttProcessingMs: null,
    averageEndpointToResultLatencyMs: null,
    averageSpeechToResultLatencyMs: null,
  };
}

export function calculatePerMinuteRate(
  count: number,
  durationMs: number,
): number | null {
  if (!Number.isFinite(count) || !Number.isFinite(durationMs) || durationMs <= 0) {
    return null;
  }
  return (Math.max(0, count) * 60_000) / durationMs;
}

export function createEmptySummary(): VoiceLabSessionSummary {
  return {
    ...createEmptyModeSummary(),
    byMode: {
      baseline: createEmptyModeSummary(),
      processed: createEmptyModeSummary(),
      'processed-vad': createEmptyModeSummary(),
      'exhibition-mix': createEmptyModeSummary(),
    },
  };
}

export function timestampFromMilliseconds(value: number): string {
  return new Date(value).toISOString();
}

export function millisecondsBetween(
  startAt: string | null,
  endAt: string | null,
): number | null {
  if (!startAt || !endAt) return null;
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return Math.max(0, end - start);
}

export function isVoiceInputDiagnostic(
  value: unknown,
): value is VoiceInputDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.type !== 'string' || typeof record.at !== 'number') {
    return false;
  }
  if (record.type === 'media_settings') {
    return Boolean(record.settings) && Number.isFinite(record.at);
  }
  if (record.type === 'capture_health') {
    if (!record.health || typeof record.health !== 'object' || Array.isArray(record.health)) {
      return false;
    }
    const health = record.health as Record<string, unknown>;
    const validEngine =
      health.engine === null ||
      health.engine === 'audio-worklet' ||
      health.engine === 'script-processor';
    const validContextState =
      health.audioContextState === 'unavailable' ||
      health.audioContextState === 'running' ||
      health.audioContextState === 'suspended' ||
      health.audioContextState === 'closed';
    const validTrackState =
      health.trackReadyState === 'unavailable' ||
      health.trackReadyState === 'live' ||
      health.trackReadyState === 'ended';
    const validStatus =
      health.status === 'probing' ||
      health.status === 'ready' ||
      health.status === 'recovering' ||
      health.status === 'failed';
    return (
      validEngine &&
      validContextState &&
      (health.trackMuted === null || typeof health.trackMuted === 'boolean') &&
      validTrackState &&
      typeof health.pcmFrameCount === 'number' &&
      Number.isFinite(health.pcmFrameCount) &&
      health.pcmFrameCount >= 0 &&
      (health.lastPcmAt === null ||
        (typeof health.lastPcmAt === 'number' &&
          Number.isFinite(health.lastPcmAt))) &&
      validStatus &&
      (health.errorCode === null || typeof health.errorCode === 'string') &&
      Number.isFinite(record.at)
    );
  }
  if (record.type === 'audio_level') {
    return (
      typeof record.audioLevel === 'number' &&
      (record.vadScore === null || typeof record.vadScore === 'number') &&
      typeof record.vadSpeech === 'boolean' &&
      typeof record.sentToStt === 'boolean' &&
      (record.noiseFloor === undefined ||
        record.noiseFloor === null ||
        typeof record.noiseFloor === 'number') &&
      (record.effectiveThreshold === undefined ||
        record.effectiveThreshold === null ||
        typeof record.effectiveThreshold === 'number') &&
      (record.vadThreshold === undefined ||
        record.vadThreshold === null ||
        typeof record.vadThreshold === 'number') &&
      Number.isFinite(record.at)
    );
  }
  if (record.type === 'vad_rejected') {
    return (
      typeof record.candidateDurationMs === 'number' &&
      typeof record.maxScore === 'number' &&
      typeof record.reason === 'string' &&
      (record.noiseFloor === undefined ||
        record.noiseFloor === null ||
        typeof record.noiseFloor === 'number') &&
      (record.effectiveThreshold === undefined ||
        record.effectiveThreshold === null ||
        typeof record.effectiveThreshold === 'number') &&
      (record.vadThreshold === undefined ||
        record.vadThreshold === null ||
        typeof record.vadThreshold === 'number') &&
      Number.isFinite(record.at)
    );
  }
  if (record.type === 'barge_in') {
    return (
      (record.action === 'duck' ||
        record.action === 'interrupt' ||
        record.action === 'restore') &&
      (record.state === 'idle' ||
        record.state === 'candidate' ||
        record.state === 'confirmed' ||
        record.state === 'restored') &&
      typeof record.ttsPlaying === 'boolean' &&
      Number.isFinite(record.at)
    );
  }
  if (record.type === 'stt_runtime') {
    return isSttRuntimeInfo(record.runtime) && Number.isFinite(record.at);
  }
  if (record.type === 'stt_queued' || record.type === 'stt_started') {
    return (
      typeof record.segmentId === 'string' && Number.isFinite(record.at)
    );
  }
  if (record.type === 'stt_observed') {
    return (
      typeof record.segmentId === 'string' &&
      typeof record.rawText === 'string' &&
      typeof record.acceptedText === 'string' &&
      Number.isFinite(record.at)
    );
  }
  return false;
}

export function isVoiceLabRecord(value: unknown): value is VoiceLabRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record.kind !== 'string' ||
    typeof record.timestamp !== 'string' ||
    typeof record.sessionId !== 'string'
  ) {
    return false;
  }
  if (!Number.isFinite(Date.parse(record.timestamp))) return false;
  if (!isExhibitionAudioPreset(record.preset)) return false;
  return [
    'session_started',
    'mode_changed',
    'utterance',
    'vad_rejected',
    'barge_in',
    'interaction_timeline',
    'error',
    'stt_runtime',
    'session_summary',
  ].includes(record.kind);
}

export function voiceEventTypeIsFinalized(
  event: VoiceInputEvent,
): boolean {
  return event.type === 'utterance_finalized';
}
