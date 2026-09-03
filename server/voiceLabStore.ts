import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  AUDIO_LAB_MODES,
  isAudioEndpointMs,
  isAudioLabMode,
  isExhibitionAudioPreset,
  isSttRuntimeInfo,
  isVoiceLabRecord,
  type VoiceLabRecord,
} from '../src/voice/audioLab.js';

export const MAX_VOICE_LAB_RECORD_BYTES = 16 * 1024;
export const VOICE_LAB_SESSION_ID_PATTERN = /^vl-[A-Za-z0-9-]{1,100}$/;

const FORBIDDEN_KEYS = new Set([
  'audio',
  'audiodata',
  'deviceid',
  'groupid',
  'pcm',
  'rawaudio',
  'rawpcm',
  'samples',
]);

const RECORD_KEYS: ReadonlyMap<VoiceLabRecord['kind'], ReadonlySet<string>> =
  new Map([
    [
      'session_started',
      new Set([
        'kind',
        'timestamp',
        'sessionId',
        'mode',
        'preset',
        'audioEndpointMs',
      ]),
    ],
    [
      'mode_changed',
      new Set([
        'kind',
        'timestamp',
        'sessionId',
        'mode',
        'preset',
        'audioEndpointMs',
      ]),
    ],
    [
      'utterance',
      new Set([
        'kind',
        'timestamp',
        'sessionId',
        'mode',
        'preset',
        'audioEndpointMs',
        'segmentId',
        'speechStartAt',
        'speechEndAt',
        'sttStartedAt',
        'sttResultAt',
        'sttLatencyMs',
        'recognizedText',
        'rawRecognizedText',
        'audioDurationMs',
        'maxVadScore',
        'vadThreshold',
        'effectiveThreshold',
        'noiseFloor',
        'vadAccepted',
        'rejectReason',
        'ttsPlayingDuringUtterance',
        'mediaTrackSettings',
        'knownHallucinationPhrase',
        'error',
        'sttQueuedAt',
        'sttObservedAt',
        'sttQueueWaitMs',
        'sttProcessingMs',
        'endpointToResultLatencyMs',
        'speechToResultLatencyMs',
      ]),
    ],
    [
      'vad_rejected',
      new Set([
        'kind',
        'timestamp',
        'sessionId',
        'mode',
        'preset',
        'audioEndpointMs',
        'speechStartAt',
        'speechEndAt',
        'audioDurationMs',
        'vadAccepted',
        'rejectReason',
        'maxVadScore',
        'vadThreshold',
        'effectiveThreshold',
        'noiseFloor',
        'ttsPlayingDuringUtterance',
        'mediaTrackSettings',
      ]),
    ],
    [
      'barge_in',
      new Set([
        'kind',
        'timestamp',
        'sessionId',
        'mode',
        'preset',
        'audioEndpointMs',
        'action',
        'state',
        'ttsPlaying',
        'playbackAgeMs',
        'reason',
      ]),
    ],
    [
      'interaction_timeline',
      new Set([
        'kind',
        'timestamp',
        'sessionId',
        'mode',
        'preset',
        'audioEndpointMs',
        'event',
      ]),
    ],
    [
      'error',
      new Set([
        'kind',
        'timestamp',
        'sessionId',
        'mode',
        'preset',
        'audioEndpointMs',
        'error',
        'segmentId',
      ]),
    ],
    [
      'stt_runtime',
      new Set([
        'kind',
        'timestamp',
        'sessionId',
        'mode',
        'preset',
        'audioEndpointMs',
        'runtime',
      ]),
    ],
    [
      'session_summary',
      new Set([
        'kind',
        'timestamp',
        'sessionId',
        'preset',
        'audioEndpointMs',
        'summary',
      ]),
    ],
  ]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function containsForbiddenKey(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsForbiddenKey);
  if (!isPlainRecord(value)) return false;

  return Object.entries(value).some(([key, nested]) => {
    return FORBIDDEN_KEYS.has(key.toLowerCase()) || containsForbiddenKey(nested);
  });
}

function validateMediaSettings(value: unknown): boolean {
  if (!isPlainRecord(value)) return value === null;
  for (const section of ['requested', 'supported', 'applied']) {
    const entry = value[section];
    if (entry === undefined) continue;
    if (!isPlainRecord(entry)) return false;
  }
  return true;
}

function validateSummary(value: unknown): boolean {
  if (!isPlainRecord(value)) return false;
  if (!isPlainRecord(value.byMode)) return false;
  for (const mode of AUDIO_LAB_MODES) {
    if (!isPlainRecord(value.byMode[mode])) return false;
  }
  return true;
}

function validateInteractionTimelineEvent(value: unknown): boolean {
  if (!isPlainRecord(value) || typeof value.kind !== 'string') return false;
  if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return false;
  return [
    'turn_signal',
    'floor_action',
    'floor_acquired',
    'floor_released',
    'pending_expired',
    'pending_discarded',
    'transcript_discarded',
    'backchannel_played',
    'tts_event',
    'barge_in',
  ].includes(value.kind);
}

function validateVoiceLabRecordShape(record: VoiceLabRecord): boolean {
  const allowedKeys = RECORD_KEYS.get(record.kind);
  if (!allowedKeys) return false;
  if (Object.keys(record).some((key) => !allowedKeys.has(key))) return false;
  if (record.kind !== 'session_summary' && !isAudioLabMode(record.mode)) {
    return false;
  }
  if (!isExhibitionAudioPreset(record.preset)) return false;
  if (
    'audioEndpointMs' in record &&
    record.audioEndpointMs !== undefined &&
    !isAudioEndpointMs(record.audioEndpointMs)
  ) {
    return false;
  }
  if (record.kind === 'utterance' || record.kind === 'vad_rejected') {
    if (!validateMediaSettings(record.mediaTrackSettings)) return false;
  }
  if (record.kind === 'stt_runtime' && !isSttRuntimeInfo(record.runtime)) {
    return false;
  }
  if (record.kind === 'session_summary' && !validateSummary(record.summary)) {
    return false;
  }
  if (
    record.kind === 'interaction_timeline' &&
    !validateInteractionTimelineEvent(record.event)
  ) {
    return false;
  }
  return true;
}

function readRecordValue(payload: unknown): unknown {
  if (!isPlainRecord(payload)) return payload;
  if (!('record' in payload)) return payload;
  if (Object.keys(payload).length !== 1) return null;
  return payload.record;
}

export function readVoiceLabRecord(payload: unknown): VoiceLabRecord {
  const value = readRecordValue(payload);
  if (
    !isPlainRecord(value) ||
    containsForbiddenKey(value) ||
    !isVoiceLabRecord(value) ||
    !validateVoiceLabRecordShape(value)
  ) {
    throw new Error('Voice Lab record is invalid.');
  }

  if (!VOICE_LAB_SESSION_ID_PATTERN.test(value.sessionId)) {
    throw new Error('Voice Lab session ID is invalid.');
  }
  if (!Number.isFinite(Date.parse(value.timestamp))) {
    throw new Error('Voice Lab record timestamp is invalid.');
  }

  const line = `${JSON.stringify(value)}\n`;
  if (Buffer.byteLength(line, 'utf8') > MAX_VOICE_LAB_RECORD_BYTES) {
    throw new Error('Voice Lab record is too large.');
  }
  return value;
}

function recordPath(root: string, sessionId: string): string {
  if (!VOICE_LAB_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error('Voice Lab session ID is invalid.');
  }
  return join(resolve(root), 'voice-lab', sessionId, 'events.jsonl');
}

export async function appendVoiceLabRecord(
  root: string,
  record: VoiceLabRecord,
): Promise<void> {
  const parsed = readVoiceLabRecord(record);
  const path = recordPath(root, parsed.sessionId);
  const line = `${JSON.stringify(parsed)}\n`;
  await mkdir(resolve(root, 'voice-lab', parsed.sessionId), {
    recursive: true,
  });
  await appendFile(path, line, { encoding: 'utf8' });
}

export async function readVoiceLabRecords(
  root: string,
  sessionId: string,
): Promise<VoiceLabRecord[]> {
  const path = recordPath(root, sessionId);
  let contents: string;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }

  const records: VoiceLabRecord[] = [];
  for (const [index, line] of contents.split(/\r?\n/).entries()) {
    if (!line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      throw new Error(`Invalid Voice Lab JSONL record at line ${index + 1}.`);
    }
    try {
      const record = readVoiceLabRecord(parsed);
      if (record.sessionId !== sessionId) {
        throw new Error('Session ID does not match.');
      }
      records.push(record);
    } catch {
      throw new Error(`Invalid Voice Lab record at line ${index + 1}.`);
    }
  }
  return records;
}
