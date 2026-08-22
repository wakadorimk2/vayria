import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  createVoiceInputController,
  reduceVoiceInput,
  type VoiceInputSnapshot,
} from '../src/voice/voiceInput.js';
import { createBrowserSpeechRecognitionAdapter } from '../src/voice/browserSpeechRecognition.js';
import {
  PCM_CHUNK_BYTES,
  StreamingPcm16Encoder,
  downmixToMono,
  encodePcm16,
} from '../src/voice/pcm16.js';
import {
  LISTENING_BACKCHANNEL_MAX_DELAY_MS,
  LISTENING_BACKCHANNEL_MIN_DELAY_MS,
  LISTENING_BACKCHANNEL_PROBABILITY,
  LISTENING_BACKCHANNEL_PROFILES,
  collectSuccessfulBackchannelAudio,
  scheduleListeningBackchannel,
  selectListeningBackchannelIndex,
} from '../src/voice/backchannelPolicy.js';
import {
  clampVadThreshold,
  DEFAULT_AUDIO_INPUT_MODE,
  DEFAULT_AUDIO_LAB_MODE,
  DEFAULT_EXHIBITION_AUDIO_PRESET,
  getExhibitionAudioPresetConfig,
  findKnownHallucinationPhrase,
  resolveInitialAudioLabMode,
  resolveExhibitionAudioPreset,
  sanitizeMediaTrackSettings,
  type VoiceLabRecord,
} from '../src/voice/audioLab.js';
import {
  RmsVad,
  calculatePcm16Rms,
} from '../src/voice/rmsVad.js';
import { AdaptiveRmsVad } from '../src/voice/adaptiveRmsVad.js';
import { reduceBargeIn } from '../src/voice/bargeIn.js';
import { VoiceLabRecorder } from '../src/voice/voiceLabRecorder.js';
import {
  appendVoiceLabRecord,
  readVoiceLabRecord,
  readVoiceLabRecords,
} from '../server/voiceLabStore.js';

const initial: VoiceInputSnapshot = {
  phase: 'idle',
  segmentId: null,
  transcript: '',
  errorCode: null,
};

interface FakeSpeechResult {
  isFinal: boolean;
  length: number;
  0: { transcript: string };
}

interface FakeSpeechResultEvent {
  resultIndex: number;
  results: {
    length: number;
    [index: number]: FakeSpeechResult;
  };
}

class FakeSpeechRecognition {
  static instances: FakeSpeechRecognition[] = [];

  lang = '';
  continuous = false;
  interimResults = false;
  maxAlternatives = 0;
  onstart: (() => void) | null = null;
  onspeechstart: (() => void) | null = null;
  onspeechend: (() => void) | null = null;
  onresult: ((event: FakeSpeechResultEvent) => void) | null = null;
  onerror: ((event: { error?: string }) => void) | null = null;
  onend: (() => void) | null = null;
  startCalls = 0;
  abortCalls = 0;

  constructor() {
    FakeSpeechRecognition.instances.push(this);
  }

  start() {
    this.startCalls += 1;
    this.onstart?.();
  }

  stop() {
    this.onend?.();
  }

  abort() {
    this.abortCalls += 1;
    this.onend?.();
  }
}

function installFakeSpeechWindow() {
  const globalWithWindow = globalThis as unknown as { window?: unknown };
  const previousWindow = globalWithWindow.window;
  FakeSpeechRecognition.instances = [];
  globalWithWindow.window = {
    SpeechRecognition: FakeSpeechRecognition,
    setTimeout,
    clearTimeout,
  };

  return () => {
    if (previousWindow === undefined) {
      delete globalWithWindow.window;
    } else {
      globalWithWindow.window = previousWindow;
    }
  };
}

function makeResult(transcript: string, isFinal: boolean): FakeSpeechResult {
  return {
    0: { transcript },
    isFinal,
    length: 1,
  };
}

function makeResultEvent(
  result: FakeSpeechResult,
): FakeSpeechResultEvent {
  return {
    resultIndex: 0,
    results: {
      0: result,
      length: 1,
    },
  };
}

function makePcmChunk(amplitude: number): ArrayBuffer {
  const pcm = new ArrayBuffer(6_400);
  const view = new DataView(pcm);
  const sample = Math.round(Math.max(-1, Math.min(amplitude, 1)) * 32_767);
  for (let offset = 0; offset < view.byteLength; offset += 2) {
    view.setInt16(offset, sample, true);
  }
  return pcm;
}

test('voice input transitions through listening and finalized states', () => {
  const controller = createVoiceInputController();

  controller.dispatch({ type: 'listening_started', at: 1 });
  assert.equal(controller.getSnapshot().phase, 'listening');

  controller.dispatch({
    type: 'speech_started',
    segmentId: 'segment-1',
    at: 2,
  });
  assert.equal(controller.getSnapshot().phase, 'speech_detected');

  controller.dispatch({
    type: 'interim_transcript_updated',
    segmentId: 'segment-1',
    text: 'おはよう',
    at: 3,
  });
  assert.equal(controller.getSnapshot().transcript, 'おはよう');

  controller.dispatch({
    type: 'utterance_finalized',
    segmentId: 'segment-1',
    text: 'おはようございます',
    at: 4,
  });
  assert.deepEqual(controller.getSnapshot(), {
    phase: 'utterance_finalized',
    segmentId: 'segment-1',
    transcript: 'おはようございます',
    errorCode: null,
  });
});

test('interim and stale events do not replace a finalized utterance', () => {
  let snapshot = reduceVoiceInput(initial, {
    type: 'speech_started',
    segmentId: 'segment-1',
    at: 1,
  });
  snapshot = reduceVoiceInput(snapshot, {
    type: 'utterance_finalized',
    segmentId: 'segment-1',
    text: '確定した発話',
    at: 2,
  });
  const finalized = snapshot;

  snapshot = reduceVoiceInput(snapshot, {
    type: 'interim_transcript_updated',
    segmentId: 'segment-1',
    text: '古い途中結果',
    at: 3,
  });
  snapshot = reduceVoiceInput(snapshot, {
    type: 'utterance_finalized',
    segmentId: 'segment-1',
    text: '重複した確定結果',
    at: 4,
  });
  snapshot = reduceVoiceInput(snapshot, {
    type: 'interim_transcript_updated',
    segmentId: 'segment-2',
    text: '別区間',
    at: 5,
  });

  assert.deepEqual(snapshot, finalized);
});

test('recognition errors and stop return inspectable state', () => {
  const controller = createVoiceInputController();
  controller.dispatch({
    type: 'recognition_failed',
    code: 'not-allowed',
    at: 1,
  });
  assert.deepEqual(controller.getSnapshot(), {
    phase: 'error',
    segmentId: null,
    transcript: '',
    errorCode: 'not-allowed',
  });

  controller.dispatch({ type: 'recognition_stopped', at: 2 });
  assert.deepEqual(controller.getSnapshot(), initial);
});

test('browser adapter maps speech events and configures Japanese interim recognition', async () => {
  const restoreWindow = installFakeSpeechWindow();
  try {
    const events: Array<{ type: string; segmentId?: string; text?: string }> = [];
    const adapter = createBrowserSpeechRecognitionAdapter({
      onEvent: (event) => events.push(event),
    });
    const recognition = FakeSpeechRecognition.instances[0];

    assert.ok(recognition);
    assert.equal(adapter.isSupported, true);
    assert.equal(recognition.lang, 'ja-JP');
    assert.equal(recognition.continuous, false);
    assert.equal(recognition.interimResults, true);
    assert.equal(recognition.maxAlternatives, 1);
    assert.equal(await adapter.start(), true);

    recognition.onspeechstart?.();
    recognition.onresult?.(makeResultEvent(makeResult('こんにちは', false)));
    recognition.onresult?.(makeResultEvent(makeResult('こんにちは', true)));
    recognition.onresult?.(makeResultEvent(makeResult('重複結果', true)));
    recognition.onspeechend?.();
    recognition.onend?.();
    await adapter.stop();

    assert.deepEqual(
      events.map((event) => event.type),
      [
        'listening_started',
        'speech_started',
        'interim_transcript_updated',
        'utterance_finalized',
        'speech_ended',
        'recognition_stopped',
      ],
    );
    assert.equal(events[3]?.text, 'こんにちは');
    adapter.dispose();
  } finally {
    restoreWindow();
  }
});

test('browser adapter restarts after end and reports permission errors', async () => {
  const restoreWindow = installFakeSpeechWindow();
  try {
    const events: Array<{ type: string; code?: string }> = [];
    const adapter = createBrowserSpeechRecognitionAdapter({
      onEvent: (event) => events.push(event),
    });
    const recognition = FakeSpeechRecognition.instances[0];

    assert.ok(recognition);
    assert.equal(await adapter.start(), true);
    recognition.onend?.();
    await new Promise((resolve) => setTimeout(resolve, 280));
    assert.equal(recognition.startCalls, 2);

    recognition.onerror?.({ error: 'not-allowed' });
    assert.equal(events.at(-1)?.type, 'recognition_failed');
    assert.equal(events.at(-1)?.code, 'not-allowed');
    await adapter.stop();
    adapter.dispose();
  } finally {
    restoreWindow();
  }
});

test('PCM16 encoder downmixes, resamples, and emits 6400-byte chunks', () => {
  const left = new Float32Array(9_600).fill(0.5);
  const right = new Float32Array(9_600).fill(-0.5);
  assert.deepEqual(Array.from(downmixToMono([left, right])), [
    ...new Array(9_600).fill(0),
  ]);

  const encoder = new StreamingPcm16Encoder(48_000);
  const chunks = encoder.push([left, right]);
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.byteLength, PCM_CHUNK_BYTES);
  assert.equal(new DataView(chunks[0]!).getInt16(0, true), 0);
});

test('PCM16 encoding clamps samples and uses little-endian signed integers', () => {
  const bytes = encodePcm16([-1, -0.5, 0, 0.5, 1, 2]);
  const view = new DataView(bytes);
  assert.deepEqual(
    [0, 1, 2, 3, 4, 5].map((index) => view.getInt16(index * 2, true)),
    [-32768, -16384, 0, 16384, 32767, 32767],
  );
});

test('listening backchannel provides six TTS profiles', () => {
  assert.deepEqual(LISTENING_BACKCHANNEL_PROFILES, [
    { rateScale: 0.92, intonationScale: 0.82 },
    { rateScale: 0.96, intonationScale: 0.96 },
    { rateScale: 1, intonationScale: 1 },
    { rateScale: 1.04, intonationScale: 1.08 },
    { rateScale: 1.08, intonationScale: 0.9 },
    { rateScale: 0.94, intonationScale: 1.16 },
  ]);
});

test('listening backchannel schedules only within the configured probability and delay', () => {
  assert.equal(
    scheduleListeningBackchannel(() => LISTENING_BACKCHANNEL_PROBABILITY),
    null,
  );
  assert.equal(
    scheduleListeningBackchannel(
      (() => {
        const values = [LISTENING_BACKCHANNEL_PROBABILITY - 0.01, 0];
        let index = 0;
        return () => values[index++] ?? 0;
      })(),
    ),
    LISTENING_BACKCHANNEL_MIN_DELAY_MS,
  );
  assert.equal(
    scheduleListeningBackchannel(
      (() => {
        const values = [LISTENING_BACKCHANNEL_PROBABILITY - 0.01, 0.999999];
        let index = 0;
        return () => values[index++] ?? 0;
      })(),
    ),
    LISTENING_BACKCHANNEL_MAX_DELAY_MS,
  );
});

test('listening backchannel selection avoids immediate repetition', () => {
  assert.equal(selectListeningBackchannelIndex(6, null, () => 0), 0);
  assert.equal(selectListeningBackchannelIndex(6, 0, () => 0), 1);
  assert.equal(selectListeningBackchannelIndex(0, null, () => 0), null);
});

test('listening backchannel pool keeps successful TTS results only', () => {
  const firstAudio = new ArrayBuffer(1);
  const secondAudio = new ArrayBuffer(2);
  assert.deepEqual(
    collectSuccessfulBackchannelAudio([
      { status: 'fulfilled', value: firstAudio },
      { status: 'rejected', reason: new Error('TTS failed') },
      { status: 'fulfilled', value: secondAudio },
    ]),
    [firstAudio, secondAudio],
  );
});

test('RMS VAD applies threshold, preroll, and three-chunk hangover', () => {
  const quiet = makePcmChunk(0.01);
  const speech = makePcmChunk(0.08);
  const vad = new RmsVad(0.02);

  assert.equal(calculatePcm16Rms(makePcmChunk(0)), 0);
  assert.equal(vad.process(makePcmChunk(0)).forwardedChunks.length, 0);
  assert.equal(vad.process(quiet, 100).events.length, 0);

  const started = vad.process(speech, 200);
  assert.deepEqual(started.events, [{ type: 'speech_started', at: 200 }]);
  assert.equal(started.forwardedChunks.length, 3);
  assert.equal(started.speechActive, true);

  assert.equal(vad.process(quiet, 300).events.length, 0);
  assert.equal(vad.process(quiet, 400).events.length, 0);
  assert.deepEqual(vad.process(quiet, 500).events, [
    { type: 'speech_ended', at: 500 },
  ]);
});

test('RMS VAD rejects low-level noise and preserves a short utterance', () => {
  const quiet = makePcmChunk(0.01);
  const speech = makePcmChunk(0.08);
  const noiseVad = new RmsVad(0.02);
  noiseVad.process(quiet, 100);
  noiseVad.process(makePcmChunk(0), 200);
  const rejected = noiseVad.process(makePcmChunk(0), 300);
  assert.equal(rejected.forwardedChunks.length, 0);
  assert.equal(rejected.events[0]?.type, 'rejected');

  const shortVad = new RmsVad(0.02);
  const short = shortVad.process(speech, 400);
  assert.equal(short.forwardedChunks.length, 1);
  assert.equal(short.events[0]?.type, 'speech_started');
  assert.deepEqual(shortVad.flush(500), [{ type: 'speech_ended', at: 500 }]);
  assert.equal(clampVadThreshold(0), 0.005);
  assert.equal(clampVadThreshold(1), 0.2);
});

test('adaptive RMS VAD updates noise floor only while idle and accepts short speech', () => {
  const adaptive = new AdaptiveRmsVad(0.005);
  assert.equal(adaptive.getNoiseFloor(), 0.005);
  assert.equal(adaptive.getEffectiveThreshold(), 0.0125);

  const quiet = adaptive.process(makePcmChunk(0.01), 100);
  assert.ok(quiet.noiseFloor > 0.005);
  assert.equal(quiet.vadThreshold, 0.005);
  assert.equal(
    quiet.effectiveThreshold,
    Math.max(0.005, quiet.noiseFloor * 2.5),
  );

  adaptive.reset();
  adaptive.setTtsPlaying(true);
  const frozenFloor = adaptive.getNoiseFloor();
  adaptive.process(makePcmChunk(0.01), 200);
  assert.equal(adaptive.getNoiseFloor(), frozenFloor);

  adaptive.reset();
  adaptive.setTtsPlaying(false);
  adaptive.process(makePcmChunk(0.01), 300);
  const shortSpeech = adaptive.process(makePcmChunk(0.08), 500);
  assert.deepEqual(shortSpeech.events, [{ type: 'speech_started', at: 500 }]);
  assert.equal(shortSpeech.forwardedChunks.length, 2);

  const aggressive = new AdaptiveRmsVad(0.02, {
    noiseFloorMultiplier: 3.0,
  });
  aggressive.process(makePcmChunk(0.01), 600);
  assert.equal(
    aggressive.getEffectiveThreshold(),
    Math.max(0.02, aggressive.getNoiseFloor() * 3.0),
  );
});

test('adaptive RMS VAD rejects a low-level candidate after two noise-floor chunks', () => {
  const adaptive = new AdaptiveRmsVad(0.02);
  adaptive.process(makePcmChunk(0.008), 100);
  adaptive.process(makePcmChunk(0), 300);
  const rejected = adaptive.process(makePcmChunk(0), 500);

  assert.deepEqual(rejected.events, [
    {
      type: 'rejected',
      at: 500,
      candidateDurationMs: 600,
      maxScore: calculatePcm16Rms(makePcmChunk(0.008)),
      reason: 'below-threshold',
    },
  ]);
  assert.equal(rejected.forwardedChunks.length, 0);
});

test('barge-in reducer ducks only with TTS and restores or interrupts correctly', () => {
  assert.deepEqual(
    reduceBargeIn('idle', { type: 'speech_started', ttsPlaying: false }),
    { state: 'idle', effects: [] },
  );

  const ducked = reduceBargeIn('idle', {
    type: 'speech_started',
    ttsPlaying: true,
  });
  assert.deepEqual(ducked, {
    state: 'ducked',
    effects: ['duck'],
    reason: 'speech-started',
  });

  assert.deepEqual(
    reduceBargeIn('ducked', {
      type: 'transcript_finalized',
      accepted: true,
    }),
    {
      state: 'confirmed',
      effects: ['interrupt', 'restore'],
      reason: 'accepted-transcript',
    },
  );
  assert.deepEqual(
    reduceBargeIn('ducked', {
      type: 'transcript_finalized',
      accepted: false,
    }),
    {
      state: 'restored',
      effects: ['restore'],
      reason: 'empty-or-filtered-transcript',
    },
  );
  assert.deepEqual(
    reduceBargeIn('ducked', { type: 'timeout' }),
    { state: 'restored', effects: ['restore'], reason: 'timeout' },
  );
  assert.deepEqual(
    reduceBargeIn('ducked', { type: 'recognition_failed' }),
    {
      state: 'restored',
      effects: ['restore'],
      reason: 'recognition-failed',
    },
  );
  assert.deepEqual(
    reduceBargeIn('ducked', { type: 'recognition_stopped' }),
    {
      state: 'restored',
      effects: ['restore'],
      reason: 'recognition-stopped',
    },
  );
  assert.deepEqual(
    reduceBargeIn('restored', {
      type: 'speech_started',
      ttsPlaying: true,
    }),
    {
      state: 'ducked',
      effects: ['duck'],
      reason: 'speech-started',
    },
  );
});

test('Audio Lab normalizes known hallucinations and anonymizes track settings', () => {
  assert.equal(
    findKnownHallucinationPhrase(' ご視聴ありがとうございました。 '),
    'ご視聴ありがとうございました',
  );
  assert.equal(
    findKnownHallucinationPhrase('ご覧いただきありがとうございました！'),
    'ご覧いただきありがとうございました',
  );
  assert.deepEqual(
    sanitizeMediaTrackSettings({
      echoCancellation: true,
      noiseSuppression: false,
      deviceId: 'do-not-save',
      groupId: 'do-not-save',
      sampleRate: 16_000,
    }),
    {
      echoCancellation: true,
      noiseSuppression: false,
      sampleRate: 16_000,
    },
  );
});

test('Audio Lab defaults to Mode D only when the debug flag is enabled', () => {
  assert.equal(DEFAULT_AUDIO_INPUT_MODE, 'baseline');
  assert.equal(DEFAULT_AUDIO_LAB_MODE, 'exhibition-mix');
  assert.equal(DEFAULT_EXHIBITION_AUDIO_PRESET, 'mild');
  assert.equal(resolveInitialAudioLabMode(true), 'exhibition-mix');
  assert.equal(resolveInitialAudioLabMode(false), 'baseline');
  assert.equal(resolveInitialAudioLabMode(false, true), 'exhibition-mix');
  assert.equal(resolveInitialAudioLabMode(false, false), 'baseline');
});

test('exhibition audio presets resolve query over environment and expose gate settings', () => {
  assert.equal(resolveExhibitionAudioPreset(null, null), 'mild');
  assert.equal(resolveExhibitionAudioPreset(null, 'aggressive'), 'aggressive');
  assert.equal(resolveExhibitionAudioPreset('off', 'aggressive'), 'off');
  assert.equal(resolveExhibitionAudioPreset('invalid', 'aggressive'), 'aggressive');
  assert.equal(resolveExhibitionAudioPreset('invalid', 'invalid'), 'mild');

  assert.deepEqual(
    getExhibitionAudioPresetConfig('off'),
    {
      requestedConstraints: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
      },
      browserGateEnabled: false,
      defaultVadThreshold: 0.02,
      noiseFloorMultiplier: 2.5,
    },
  );
  assert.equal(getExhibitionAudioPresetConfig('mild').defaultVadThreshold, 0.02);
  assert.equal(getExhibitionAudioPresetConfig('mild').noiseFloorMultiplier, 2.5);
  assert.equal(
    getExhibitionAudioPresetConfig('aggressive').defaultVadThreshold,
    0.04,
  );
  assert.equal(
    getExhibitionAudioPresetConfig('aggressive').noiseFloorMultiplier,
    3.0,
  );
});

test('Voice Lab recorder measures latency, known errors, TTS overlap, and summary', () => {
  const records: VoiceLabRecord[] = [];
  const recorder = new VoiceLabRecorder({
    enabled: true,
    mode: 'processed',
    preset: 'mild',
    sessionId: 'vl-test-session',
    onRecord: (record) => records.push(record),
  });
  recorder.start();
  recorder.setTtsPlaying(true);
  recorder.handleDiagnostic({
    type: 'media_settings',
    at: 1_000,
    settings: {
      requested: { echoCancellation: true },
      supported: { echoCancellation: true },
      applied: { echoCancellation: true },
    },
  });
  recorder.handleVoiceEvent({
    type: 'speech_started',
    segmentId: 'segment-1',
    at: 1_000,
  });
  recorder.handleDiagnostic({
    type: 'stt_started',
    segmentId: 'segment-1',
    at: 1_200,
  });
  recorder.handleVoiceEvent({
    type: 'speech_ended',
    segmentId: 'segment-1',
    at: 1_300,
  });
  recorder.handleDiagnostic({
    type: 'stt_observed',
    segmentId: 'segment-1',
    at: 1_400,
    rawText: 'ご視聴ありがとうございました。',
    acceptedText: '',
    filterReason: 'known-hallucination',
  });
  recorder.handleVoiceEvent({
    type: 'utterance_finalized',
    segmentId: 'segment-1',
    text: '',
    at: 1_400,
  });
  recorder.finish();

  const snapshot = recorder.getSnapshot();
  const utterance = snapshot.records.find((record) => record.kind === 'utterance');
  assert.equal(utterance?.kind, 'utterance');
  if (utterance?.kind !== 'utterance') return;
  assert.equal(utterance.rawRecognizedText, 'ご視聴ありがとうございました。');
  assert.equal(utterance.knownHallucinationPhrase, 'ご視聴ありがとうございました');
  assert.equal(utterance.sttLatencyMs, 200);
  assert.equal(utterance.audioDurationMs, 300);
  assert.equal(utterance.ttsPlayingDuringUtterance, true);
  assert.equal(snapshot.summary.knownHallucinationCount, 1);
  assert.equal(snapshot.summary.ttsOverlapCount, 1);
  assert.equal(snapshot.summary.averageSttLatencyMs, 200);
  assert.equal(records.at(-1)?.kind, 'session_summary');
  assert.equal(records[0]?.preset, 'mild');
});

test('Voice Lab recorder stores Mode D thresholds and barge-in summary metrics', () => {
  const recorder = new VoiceLabRecorder({
    enabled: true,
    mode: 'exhibition-mix',
    preset: 'aggressive',
    sessionId: 'vl-mode-d-session',
  });
  recorder.start();
  recorder.setTtsPlaying(true);
  recorder.handleDiagnostic({
    type: 'audio_level',
    at: 1_000,
    audioLevel: 0.01,
    vadScore: 0.01,
    vadSpeech: false,
    sentToStt: false,
    noiseFloor: 0.006,
    effectiveThreshold: 0.02,
    vadThreshold: 0.02,
  });
  recorder.handleVoiceEvent({
    type: 'speech_started',
    segmentId: 'mode-d-segment',
    at: 1_200,
  });
  recorder.handleDiagnostic({
    type: 'audio_level',
    at: 1_300,
    audioLevel: 0.08,
    vadScore: 0.08,
    vadSpeech: true,
    sentToStt: true,
    noiseFloor: 0.006,
    effectiveThreshold: 0.02,
    vadThreshold: 0.02,
  });
  recorder.handleDiagnostic({
    type: 'stt_started',
    segmentId: 'mode-d-segment',
    at: 1_400,
  });
  recorder.handleVoiceEvent({
    type: 'speech_ended',
    segmentId: 'mode-d-segment',
    at: 1_500,
  });
  recorder.handleDiagnostic({
    type: 'stt_observed',
    segmentId: 'mode-d-segment',
    at: 1_600,
    rawText: 'こんにちは',
    acceptedText: 'こんにちは',
  });
  recorder.handleVoiceEvent({
    type: 'utterance_finalized',
    segmentId: 'mode-d-segment',
    text: 'こんにちは',
    at: 1_600,
  });
  recorder.handleDiagnostic({
    type: 'vad_rejected',
    at: 1_800,
    candidateDurationMs: 400,
    maxScore: 0.012,
    reason: 'below-threshold',
    noiseFloor: 0.006,
    effectiveThreshold: 0.02,
    vadThreshold: 0.02,
  });
  recorder.handleDiagnostic({
    type: 'barge_in',
    at: 1_900,
    action: 'duck',
    state: 'ducked',
    ttsPlaying: true,
  });
  recorder.handleDiagnostic({
    type: 'barge_in',
    at: 2_000,
    action: 'interrupt',
    state: 'confirmed',
    ttsPlaying: true,
    reason: 'accepted-transcript',
  });
  recorder.handleDiagnostic({
    type: 'barge_in',
    at: 2_100,
    action: 'restore',
    state: 'restored',
    ttsPlaying: true,
    reason: 'timeout',
  });
  recorder.finish();

  const snapshot = recorder.getSnapshot();
  const utterance = snapshot.records.find((record) => record.kind === 'utterance');
  assert.equal(utterance?.kind, 'utterance');
  if (utterance?.kind !== 'utterance') return;
  assert.equal(utterance.maxVadScore, 0.08);
  assert.equal(utterance.vadThreshold, 0.02);
  assert.equal(utterance.effectiveThreshold, 0.02);
  assert.equal(utterance.noiseFloor, 0.006);
  assert.equal(snapshot.summary.candidateCount, 2);
  assert.equal(snapshot.summary.byMode['exhibition-mix'].candidateCount, 2);
  assert.equal(snapshot.summary.bargeInTriggeredCount, 1);
  assert.equal(snapshot.summary.bargeInConfirmedCount, 1);
  assert.equal(snapshot.summary.bargeInRestoredCount, 1);
  assert.equal(snapshot.summary.bargeInTimeoutCount, 1);
  assert.equal(
    snapshot.records.find((record) => record.kind === 'utterance')?.preset,
    'aggressive',
  );
});

test('Voice Lab JSONL validates session IDs, size, and forbidden audio identifiers', async () => {
  const root = await mkdtemp(join(tmpdir(), 'vayria-voice-lab-'));
  try {
    const record = {
      kind: 'session_started' as const,
      timestamp: '2026-08-22T00:00:00.000Z',
      sessionId: 'vl-store-session',
      mode: 'baseline' as const,
      preset: 'mild' as const,
    };
    assert.deepEqual(readVoiceLabRecord({ record }), record);
    await appendVoiceLabRecord(root, record);
    assert.deepEqual(await readVoiceLabRecords(root, record.sessionId), [record]);
    assert.throws(
      () => readVoiceLabRecord({ ...record, sessionId: '../escape' }),
      /session ID is invalid/,
    );
    assert.throws(
      () => readVoiceLabRecord({ ...record, deviceId: 'must-not-save' }),
      /record is invalid/,
    );
    assert.throws(
      () => readVoiceLabRecord({ ...record, preset: 'invalid' }),
      /record is invalid/,
    );
    assert.throws(
      () =>
        readVoiceLabRecord({
          kind: 'session_summary',
          timestamp: '2026-08-22T00:00:00.000Z',
          sessionId: 'vl-store-session',
          preset: 'mild',
          summary: {
            utteranceCount: 0,
            sttSuccessCount: 0,
            vadRejectCount: 0,
            noiseLikeSttCount: 0,
            knownHallucinationCount: 0,
            ttsOverlapCount: 0,
            averageSttLatencyMs: null,
            byMode: {
              baseline: {},
              processed: {},
              'processed-vad': {},
              'exhibition-mix': {},
            },
            padding: 'x'.repeat(20_000),
          },
        }),
      /too large/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
