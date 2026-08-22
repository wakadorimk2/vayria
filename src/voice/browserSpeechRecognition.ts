import { MAX_VOICE_TEXT_LENGTH } from './voiceInput.js';
import type {
  VoiceInputAdapter,
  VoiceInputAdapterOptions,
} from './voiceAdapter.js';

interface SpeechRecognitionAlternativeLike {
  transcript: string;
}

interface SpeechRecognitionResultLike {
  isFinal: boolean;
  length: number;
  [index: number]: SpeechRecognitionAlternativeLike;
}

interface SpeechRecognitionEventLike {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: SpeechRecognitionResultLike;
  };
}

interface SpeechRecognitionErrorEventLike {
  error?: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  maxAlternatives: number;
  onstart: (() => void) | null;
  onspeechstart: (() => void) | null;
  onspeechend: (() => void) | null;
  onresult: ((event: SpeechRecognitionEventLike) => void) | null;
  onerror: ((event: SpeechRecognitionErrorEventLike) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

type SpeechRecognitionConstructor = new () => SpeechRecognitionLike;

interface SpeechRecognitionWindow extends Window {
  SpeechRecognition?: SpeechRecognitionConstructor;
  webkitSpeechRecognition?: SpeechRecognitionConstructor;
}

export type BrowserSpeechRecognitionAdapter = VoiceInputAdapter;
type BrowserSpeechRecognitionOptions = VoiceInputAdapterOptions;

function now(): number {
  return Date.now();
}

function readSpeechRecognitionConstructor(): SpeechRecognitionConstructor | null {
  if (typeof window === 'undefined') return null;
  const speechWindow = window as SpeechRecognitionWindow;
  return speechWindow.SpeechRecognition ?? speechWindow.webkitSpeechRecognition ?? null;
}

function readTranscript(result: SpeechRecognitionResultLike): string {
  return result.length > 0 ? result[0]?.transcript?.trim() ?? '' : '';
}

export function createBrowserSpeechRecognitionAdapter(
  options: BrowserSpeechRecognitionOptions,
): BrowserSpeechRecognitionAdapter {
  const Recognition = readSpeechRecognitionConstructor();
  if (!Recognition) {
    return {
      isSupported: false,
      supportErrorCode: 'unsupported',
      start: async () => false,
      stop: async () => undefined,
      dispose: () => undefined,
    };
  }

  const recognition = new Recognition();
  let enabled = false;
  let disposed = false;
  let running = false;
  let restartTimer: number | null = null;
  let segmentSequence = 0;
  let segmentId: string | null = null;
  let speechEnded = false;
  let finalized = false;

  const clearRestartTimer = () => {
    if (restartTimer === null || typeof window === 'undefined') return;
    window.clearTimeout(restartTimer);
    restartTimer = null;
  };

  const createSegment = () => {
    if (segmentId !== null) return segmentId;
    segmentSequence += 1;
    segmentId = `voice-segment-${segmentSequence}`;
    speechEnded = false;
    options.onEvent({ type: 'speech_started', segmentId, at: now() });
    return segmentId;
  };

  const scheduleRestart = () => {
    if (!enabled || disposed || typeof window === 'undefined') return;
    clearRestartTimer();
    restartTimer = window.setTimeout(() => {
      restartTimer = null;
      if (enabled && !disposed) {
        try {
          recognition.start();
        } catch {
          scheduleRestart();
        }
      }
    }, 250);
  };

  const handleEnd = () => {
    running = false;
    if (segmentId !== null && !speechEnded) {
      options.onEvent({ type: 'speech_ended', segmentId, at: now() });
    }
    segmentId = null;
    speechEnded = false;
    finalized = false;
    scheduleRestart();
  };

  recognition.lang = options.language ?? 'ja-JP';
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.maxAlternatives = 1;
  recognition.onstart = () => {
    running = true;
    segmentId = null;
    finalized = false;
    options.onEvent({ type: 'listening_started', at: now() });
  };
  recognition.onspeechstart = () => {
    createSegment();
  };
  recognition.onspeechend = () => {
    if (segmentId !== null && !speechEnded) {
      options.onEvent({ type: 'speech_ended', segmentId, at: now() });
      speechEnded = true;
    }
  };
  recognition.onresult = (event) => {
    const activeSegmentId = createSegment();
    let interimText = '';

    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index];
      const transcript = readTranscript(result);
      if (!transcript) continue;
      if (result.isFinal && !finalized) {
        finalized = true;
        options.onDiagnostic?.({
          type: 'stt_observed',
          segmentId: activeSegmentId,
          rawText: transcript,
          acceptedText: transcript,
          at: now(),
        });
        options.onEvent({
          type: 'utterance_finalized',
          segmentId: activeSegmentId,
          text: transcript,
          at: now(),
        });
      } else if (!result.isFinal) {
        interimText += `${transcript} `;
      }
    }

    if (interimText.trim() && !finalized) {
      options.onEvent({
        type: 'interim_transcript_updated',
        segmentId: activeSegmentId,
        text: interimText.trim().slice(0, MAX_VOICE_TEXT_LENGTH + 1),
        at: now(),
      });
    }
  };
  recognition.onerror = (event) => {
    const code = event.error || 'unknown';
    if (code === 'no-speech') {
      scheduleRestart();
      return;
    }
    options.onEvent({ type: 'recognition_failed', code, at: now() });
    if (code === 'not-allowed' || code === 'service-not-allowed' || code === 'audio-capture') {
      enabled = false;
      clearRestartTimer();
    } else {
      scheduleRestart();
    }
  };
  recognition.onend = handleEnd;

  return {
    isSupported: true,
    supportErrorCode: null,
    async start() {
      if (disposed) return false;
      enabled = true;
      clearRestartTimer();
      if (running) return true;
      try {
        recognition.start();
        return true;
      } catch {
        scheduleRestart();
        return false;
      }
    },
    async stop() {
      enabled = false;
      clearRestartTimer();
      if (!running) {
        options.onEvent({ type: 'recognition_stopped', at: now() });
        return;
      }
      try {
        recognition.abort();
      } catch {
        // The browser can already have ended the recognition session.
      }
      running = false;
      segmentId = null;
      speechEnded = false;
      finalized = false;
      options.onEvent({ type: 'recognition_stopped', at: now() });
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      enabled = false;
      clearRestartTimer();
      try {
        recognition.abort();
      } catch {
        // The browser can already have ended the recognition session.
      }
      recognition.onstart = null;
      recognition.onspeechstart = null;
      recognition.onspeechend = null;
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
    },
  };
}
