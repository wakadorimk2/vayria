import assert from 'node:assert/strict';
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
  type ListeningBackchannelAudio,
  scheduleListeningBackchannel,
  selectListeningBackchannelIndex,
} from '../src/voice/backchannelPolicy.js';
import { isVoiceInteractionDecision } from '../src/voice/voiceInteraction.js';

const initial: VoiceInputSnapshot = {
  phase: 'idle',
  segmentId: null,
  transcript: '',
  errorCode: null,
};

test('voice reaction contract keeps backchannel cues compatible', () => {
  assert.equal(
    isVoiceInteractionDecision({
      action: 'listen',
      backchannelCue: 'none',
    }),
    true,
  );
  assert.equal(
    isVoiceInteractionDecision({
      action: 'backchannel',
      backchannelCue: 'uun',
    }),
    true,
  );
  assert.equal(
    isVoiceInteractionDecision({
      action: 'backchannel',
      backchannelCue: 'none',
    }),
    false,
  );
  assert.equal(
    isVoiceInteractionDecision({
      action: 'take_floor',
      backchannelCue: 'un',
    }),
    false,
  );
});

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

test('listening backchannel provides three TTS profiles', () => {
  assert.deepEqual(LISTENING_BACKCHANNEL_PROFILES, [
    { rateScale: 0.92, intonationScale: 0.82 },
    { rateScale: 1, intonationScale: 1 },
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
  assert.equal(selectListeningBackchannelIndex(3, null, () => 0), 0);
  assert.equal(selectListeningBackchannelIndex(3, 0, () => 0), 1);
  assert.equal(selectListeningBackchannelIndex(0, null, () => 0), null);
});

test('listening backchannel pool keeps successful TTS results only', () => {
  const firstAudio: ListeningBackchannelAudio = {
    cue: 'un',
    variantIndex: 0,
    audioData: new ArrayBuffer(1),
  };
  const secondAudio: ListeningBackchannelAudio = {
    cue: 'uun',
    variantIndex: 1,
    audioData: new ArrayBuffer(2),
  };
  assert.deepEqual(
    collectSuccessfulBackchannelAudio([
      { status: 'fulfilled', value: firstAudio },
      { status: 'rejected', reason: new Error('TTS failed') },
      { status: 'fulfilled', value: secondAudio },
    ]),
    [firstAudio, secondAudio],
  );
});
