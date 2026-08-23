export const MAX_VOICE_TEXT_LENGTH = 1_000;

export type VoiceInputPhase =
  | 'idle'
  | 'listening'
  | 'speech_detected'
  | 'utterance_finalized'
  | 'error';

export interface ListeningReactionCue {
  id: number;
  kind: 'nod' | 'thinking';
  target: 'viewer';
}

export interface VoiceSpeakerMetadata {
  speakerId?: string | null;
}

export type VoiceInputEvent =
  | { type: 'listening_started'; at: number }
  | ({ type: 'speech_started'; segmentId: string; at: number } &
      VoiceSpeakerMetadata)
  | ({
      type: 'interim_transcript_updated';
      segmentId: string;
      text: string;
      at: number;
    } & VoiceSpeakerMetadata)
  | ({ type: 'speech_ended'; segmentId: string; at: number } &
      VoiceSpeakerMetadata)
  | ({
      type: 'utterance_finalized';
      segmentId: string;
      text: string;
      at: number;
    } & VoiceSpeakerMetadata)
  | { type: 'recognition_stopped'; at: number }
  | { type: 'recognition_failed'; code: string; at: number };

export interface VoiceInputSnapshot {
  phase: VoiceInputPhase;
  segmentId: string | null;
  transcript: string;
  errorCode: string | null;
}

export const INITIAL_VOICE_INPUT_SNAPSHOT: VoiceInputSnapshot = {
  phase: 'idle',
  segmentId: null,
  transcript: '',
  errorCode: null,
};

function isCurrentSegment(
  snapshot: VoiceInputSnapshot,
  segmentId: string,
): boolean {
  return snapshot.segmentId === null || snapshot.segmentId === segmentId;
}

export function reduceVoiceInput(
  snapshot: VoiceInputSnapshot,
  event: VoiceInputEvent,
): VoiceInputSnapshot {
  switch (event.type) {
    case 'listening_started':
      return {
        phase: 'listening',
        segmentId: null,
        transcript: '',
        errorCode: null,
      };
    case 'speech_started':
      return {
        phase: 'speech_detected',
        segmentId: event.segmentId,
        transcript: '',
        errorCode: null,
      };
    case 'interim_transcript_updated':
      if (!isCurrentSegment(snapshot, event.segmentId)) return snapshot;
      if (
        snapshot.phase === 'utterance_finalized' &&
        snapshot.segmentId === event.segmentId
      ) {
        return snapshot;
      }
      return {
        ...snapshot,
        phase: 'speech_detected',
        segmentId: event.segmentId,
        transcript: event.text,
        errorCode: null,
      };
    case 'speech_ended':
      if (!isCurrentSegment(snapshot, event.segmentId)) return snapshot;
      if (snapshot.phase === 'utterance_finalized') return snapshot;
      return {
        ...snapshot,
        phase: 'listening',
      };
    case 'utterance_finalized':
      if (!isCurrentSegment(snapshot, event.segmentId)) return snapshot;
      if (
        snapshot.phase === 'utterance_finalized' &&
        snapshot.segmentId === event.segmentId
      ) {
        return snapshot;
      }
      return {
        phase: 'utterance_finalized',
        segmentId: event.segmentId,
        transcript: event.text,
        errorCode: null,
      };
    case 'recognition_stopped':
      return INITIAL_VOICE_INPUT_SNAPSHOT;
    case 'recognition_failed':
      return {
        phase: 'error',
        segmentId: null,
        transcript: '',
        errorCode: event.code,
      };
  }
}

export interface VoiceInputController {
  dispatch(event: VoiceInputEvent): VoiceInputSnapshot;
  getSnapshot(): VoiceInputSnapshot;
  subscribe(listener: (snapshot: VoiceInputSnapshot) => void): () => void;
}

export function createVoiceInputController(
  initialSnapshot: VoiceInputSnapshot = INITIAL_VOICE_INPUT_SNAPSHOT,
): VoiceInputController {
  let snapshot = initialSnapshot;
  const listeners = new Set<(nextSnapshot: VoiceInputSnapshot) => void>();

  return {
    dispatch(event) {
      snapshot = reduceVoiceInput(snapshot, event);
      for (const listener of listeners) listener(snapshot);
      return snapshot;
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
