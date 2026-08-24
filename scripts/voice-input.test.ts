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
  LISTENING_BACKCHANNEL_PROFILES,
  collectSuccessfulBackchannelAudio,
  type ListeningBackchannelAudio,
  selectListeningBackchannelIndex,
} from '../src/voice/backchannelPolicy.js';
import {
  DEFAULT_AUDIO_ENDPOINT_MS,
  AUDIO_ENDPOINT_VALUES,
  BARGE_IN_DUCK_GAIN,
  calculatePerMinuteRate,
  clampVadThreshold,
  DEFAULT_AUDIO_INPUT_MODE,
  DEFAULT_AUDIO_LAB_MODE,
  DEFAULT_EXHIBITION_MIX_ENDPOINT_MS,
  DEFAULT_EXHIBITION_AUDIO_PRESET,
  getEffectiveAudioEndpointMs,
  getExhibitionAudioPresetConfig,
  findKnownHallucinationPhrase,
  resolveInitialAudioLabMode,
  resolveAudioEndpointMs,
  resolveExhibitionAudioPreset,
  sanitizeMediaTrackSettings,
  type VoiceLabRecord,
} from '../src/voice/audioLab.js';
import {
  getVadHangoverChunkCount,
  RmsVad,
  calculatePcm16Rms,
} from '../src/voice/rmsVad.js';
import { AdaptiveRmsVad } from '../src/voice/adaptiveRmsVad.js';
import {
  isConfirmedBargeInTranscript,
  isRejectedBargeInCandidate,
  reduceBargeIn,
  shouldInterruptBusyTurn,
} from '../src/voice/bargeIn.js';
import { createInteractionTimeline } from '../src/conversation/interactionTimeline.js';
import {
  FIRST_PCM_FRAME_TIMEOUT_MS,
  createRemotePcmVoiceAdapter,
  isPcm16Chunk,
} from '../src/voice/remotePcmVoiceAdapter.js';
import { VoiceLabRecorder } from '../src/voice/voiceLabRecorder.js';
import {
  appendVoiceLabRecord,
  readVoiceLabRecord,
  readVoiceLabRecords,
} from '../server/voiceLabStore.js';
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
      action: 'react_nonverbally',
      backchannelCue: 'none',
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

function makePcmChunk(amplitude: number): ArrayBuffer {
  const pcm = new ArrayBuffer(6_400);
  const view = new DataView(pcm);
  const sample = Math.round(Math.max(-1, Math.min(amplitude, 1)) * 32_767);
  for (let offset = 0; offset < view.byteLength; offset += 2) {
    view.setInt16(offset, sample, true);
  }
  return pcm;
}

class FakeRemoteAudioNode extends EventTarget {
  connect(node: unknown) {
    return node;
  }

  disconnect() {}
}

class FakeRemoteGainNode extends FakeRemoteAudioNode {
  gain = { value: 1 };
}

class FakeRemoteScriptProcessor extends FakeRemoteAudioNode {
  static instances: FakeRemoteScriptProcessor[] = [];

  onaudioprocess: ((event: AudioProcessingEvent) => void) | null = null;

  constructor() {
    super();
    FakeRemoteScriptProcessor.instances.push(this);
  }

  emit(channels: Float32Array[]) {
    const inputBuffer = {
      numberOfChannels: channels.length,
      getChannelData(channelIndex: number) {
        return channels[channelIndex] ?? new Float32Array();
      },
    };
    this.onaudioprocess?.({ inputBuffer } as AudioProcessingEvent);
  }
}

class FakeRemoteTrack extends EventTarget {
  muted = false;
  readyState: MediaStreamTrackState = 'live';

  getSettings() {
    return {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: false,
      sampleRate: 48_000,
      channelCount: 1,
    };
  }

  stop() {
    this.readyState = 'ended';
  }
}

class FakeRemoteStream {
  constructor(private readonly track: FakeRemoteTrack) {}

  getAudioTracks() {
    return [this.track];
  }

  getTracks() {
    return [this.track];
  }
}

class FakeRemoteAudioContext extends EventTarget {
  static instances: FakeRemoteAudioContext[] = [];

  readonly sampleRate = 48_000;
  readonly destination = {};
  readonly audioWorklet = {
    addModule: async () => undefined,
  };
  state: AudioContextState = 'running';

  constructor() {
    super();
    FakeRemoteAudioContext.instances.push(this);
  }

  async resume() {
    this.state = 'running';
  }

  async close() {
    this.state = 'closed';
  }

  createMediaStreamSource() {
    return new FakeRemoteAudioNode() as unknown as MediaStreamAudioSourceNode;
  }

  createGain() {
    return new FakeRemoteGainNode() as unknown as GainNode;
  }

  createScriptProcessor() {
    return new FakeRemoteScriptProcessor() as unknown as ScriptProcessorNode;
  }
}

class FakeRemoteAudioWorkletNode extends FakeRemoteAudioNode {
  static instances: FakeRemoteAudioWorkletNode[] = [];

  readonly port = {
    onmessage: null as ((event: MessageEvent<unknown>) => void) | null,
    close() {},
  };

  constructor() {
    super();
    FakeRemoteAudioWorkletNode.instances.push(this);
  }

  emit(data: ArrayBuffer) {
    this.port.onmessage?.({ data } as MessageEvent<unknown>);
  }
}

class FakeRemoteWebSocket extends EventTarget {
  static readonly OPEN = 1;
  static readonly CONNECTING = 0;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeRemoteWebSocket[] = [];

  readonly sent: unknown[] = [];
  binaryType = '';
  bufferedAmount = 0;
  readyState = FakeRemoteWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: MessageEvent<unknown>) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: (() => void) | null = null;

  constructor(public readonly url: string) {
    super();
    FakeRemoteWebSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState !== FakeRemoteWebSocket.CONNECTING) return;
      this.readyState = FakeRemoteWebSocket.OPEN;
      this.dispatchEvent(new Event('open'));
      this.onopen?.();
    });
  }

  send(data: unknown) {
    this.sent.push(data);
    if (typeof data !== 'string') return;
    const parsed = JSON.parse(data) as { type?: string };
    if (parsed.type !== 'start') return;
    queueMicrotask(() => {
      this.onmessage?.({
        data: JSON.stringify({ type: 'listening_started', at: Date.now() }),
      } as MessageEvent<unknown>);
    });
  }

  close() {
    if (this.readyState === FakeRemoteWebSocket.CLOSED) return;
    this.readyState = FakeRemoteWebSocket.CLOSED;
    this.onclose?.();
    this.dispatchEvent(new Event('close'));
  }
}

class FakeRemoteWindow extends EventTarget {
  isSecureContext = true;
  readonly location = { href: 'https://vayria.test/' };
  readonly AudioContext = FakeRemoteAudioContext;

  constructor(private readonly timerScale: number) {
    super();
  }

  setTimeout(
    callback: (...args: unknown[]) => void,
    timeout = 0,
  ): ReturnType<typeof globalThis.setTimeout> {
    return globalThis.setTimeout(callback, timeout * this.timerScale);
  }

  clearTimeout(timerId: ReturnType<typeof globalThis.setTimeout>) {
    globalThis.clearTimeout(timerId);
  }
}

function installRemoteBrowserEnvironment(options: { timerScale?: number } = {}) {
  const previous = new Map<string, PropertyDescriptor | undefined>();
  const setGlobal = (name: string, value: unknown) => {
    previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, {
      configurable: true,
      enumerable: true,
      writable: true,
      value,
    });
  };

  FakeRemoteAudioContext.instances = [];
  FakeRemoteAudioWorkletNode.instances = [];
  FakeRemoteScriptProcessor.instances = [];
  FakeRemoteWebSocket.instances = [];
  const tracks: FakeRemoteTrack[] = [];
  let getUserMediaCalls = 0;
  let lastGetUserMediaConstraints: MediaStreamConstraints | null = null;
  const fakeDocument = new EventTarget() as EventTarget & { hidden: boolean };
  fakeDocument.hidden = false;
  const fakeWindow = new FakeRemoteWindow(options.timerScale ?? 1);
  const fakeNavigator = {
    mediaDevices: {
      async getUserMedia(constraints?: MediaStreamConstraints) {
        getUserMediaCalls += 1;
        lastGetUserMediaConstraints = constraints ?? null;
        const track = new FakeRemoteTrack();
        tracks.push(track);
        return new FakeRemoteStream(track) as unknown as MediaStream;
      },
      getSupportedConstraints() {
        return {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        };
      },
    },
  };

  setGlobal('window', fakeWindow);
  setGlobal('document', fakeDocument);
  setGlobal('navigator', fakeNavigator);
  setGlobal('WebSocket', FakeRemoteWebSocket);
  setGlobal('AudioWorkletNode', FakeRemoteAudioWorkletNode);

  return {
    fakeDocument,
    fakeWindow,
    tracks,
    get getUserMediaCalls() {
      return getUserMediaCalls;
    },
    get lastGetUserMediaConstraints() {
      return lastGetUserMediaConstraints;
    },
    worklets: FakeRemoteAudioWorkletNode.instances,
    scripts: FakeRemoteScriptProcessor.instances,
    sockets: FakeRemoteWebSocket.instances,
    restore() {
      for (const [name, descriptor] of previous) {
        if (descriptor) {
          Object.defineProperty(globalThis, name, descriptor);
        } else {
          delete (globalThis as unknown as Record<string, unknown>)[name];
        }
      }
    },
  };
}

async function waitForRemoteCondition(
  predicate: () => boolean,
  timeoutMs = 2_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('Remote test condition timed out.');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
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

test('remote PCM adapter validates the first AudioWorklet frame before activation', async () => {
  const environment = installRemoteBrowserEnvironment();
  try {
    const events: Array<{ type: string; code?: string }> = [];
    const health: Array<{ engine: string | null; status: string; pcmFrameCount: number }> = [];
    const adapter = createRemotePcmVoiceAdapter({
      audioMode: 'baseline',
      diagnostics: true,
      onEvent: (event) => events.push(event),
      onDiagnostic: (diagnostic) => {
        if (diagnostic.type !== 'capture_health') return;
        health.push({
          engine: diagnostic.health.engine,
          status: diagnostic.health.status,
          pcmFrameCount: diagnostic.health.pcmFrameCount,
        });
      },
    });

    const startPromise = adapter.start();
    await waitForRemoteCondition(() => environment.worklets.length === 1);
    environment.worklets[0]!.emit(makePcmChunk(0.1));

    assert.equal(await startPromise, true);
    assert.equal(isPcm16Chunk(makePcmChunk(0)), true);
    assert.equal(isPcm16Chunk(new ArrayBuffer(1)), false);
    assert.equal(health.at(-1)?.engine, 'audio-worklet');
    assert.equal(health.at(-1)?.status, 'ready');
    assert.equal(health.at(-1)?.pcmFrameCount, 1);
    assert.ok(events.some((event) => event.type === 'listening_started'));
    assert.ok(environment.sockets[0]?.sent.some((value) => value instanceof ArrayBuffer));
    assert.equal(
      environment.sockets[0]?.sent.some(
        (value) =>
          typeof value === 'string' &&
          ['speech_started', 'speech_ended'].includes(
            (JSON.parse(value) as { type?: string }).type ?? '',
          ),
      ),
      false,
    );

    await adapter.stop();
    adapter.dispose();
  } finally {
    environment.restore();
  }
});

test('processed remote adapter gates low-level noise but forwards speech-level audio', async () => {
  const environment = installRemoteBrowserEnvironment();
  try {
    const diagnostics: Array<{
      type: string;
      noiseFloor?: number | null;
      effectiveThreshold?: number | null;
    }> = [];
    const adapter = createRemotePcmVoiceAdapter({
      audioMode: 'processed',
      audioPreset: 'mild',
      diagnostics: true,
      onEvent: () => undefined,
      onDiagnostic: (diagnostic) => {
        diagnostics.push({
          type: diagnostic.type,
          ...(diagnostic.type === 'audio_level'
            ? {
                noiseFloor: diagnostic.noiseFloor,
                effectiveThreshold: diagnostic.effectiveThreshold,
              }
            : {}),
        });
      },
    });

    const startPromise = adapter.start();
    await waitForRemoteCondition(() => environment.worklets.length === 1);
    environment.worklets[0]!.emit(makePcmChunk(0.01));

    assert.equal(await startPromise, true);
    const socket = environment.sockets[0];
    const hasBinaryFrame = () =>
      socket?.sent.some((value) => value instanceof ArrayBuffer) ?? false;
    assert.equal(hasBinaryFrame(), false);

    environment.worklets[0]!.emit(makePcmChunk(0.01));
    environment.worklets[0]!.emit(makePcmChunk(0));
    environment.worklets[0]!.emit(makePcmChunk(0));
    assert.equal(hasBinaryFrame(), false);

    environment.worklets[0]!.emit(makePcmChunk(0.08));
    assert.equal(hasBinaryFrame(), true);
    assert.ok(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.type === 'audio_level' &&
          diagnostic.noiseFloor !== null &&
          diagnostic.effectiveThreshold !== null,
      ),
    );
    environment.worklets[0]!.emit(makePcmChunk(0.01));
    environment.worklets[0]!.emit(makePcmChunk(0.01));
    environment.worklets[0]!.emit(makePcmChunk(0.01));

    const sentSequence =
      socket?.sent.map((value) => {
        if (value instanceof ArrayBuffer) return 'pcm';
        if (typeof value !== 'string') return 'other';
        return (JSON.parse(value) as { type?: string }).type ?? 'json';
      }) ?? [];
    const speechStartedIndex = sentSequence.indexOf('speech_started');
    const firstPcmIndex = sentSequence.indexOf('pcm');
    const speechEndedIndex = sentSequence.indexOf('speech_ended');
    assert.ok(speechStartedIndex >= 0);
    assert.ok(firstPcmIndex > speechStartedIndex);
    assert.ok(speechEndedIndex > firstPcmIndex);

    await adapter.stop();
    adapter.dispose();
  } finally {
    environment.restore();
  }
});

test('off preset forwards PCM without browser speech boundary controls', async () => {
  const environment = installRemoteBrowserEnvironment();
  try {
    const adapter = createRemotePcmVoiceAdapter({
      audioMode: 'processed',
      audioPreset: 'off',
      onEvent: () => undefined,
    });

    const startPromise = adapter.start();
    await waitForRemoteCondition(() => environment.worklets.length === 1);
    environment.worklets[0]!.emit(makePcmChunk(0.08));
    assert.equal(await startPromise, true);
    environment.worklets[0]!.emit(makePcmChunk(0));

    const controlTypes =
      environment.sockets[0]?.sent.flatMap((value) => {
        if (typeof value !== 'string') return [];
        const type = (JSON.parse(value) as { type?: string }).type;
        return type === 'speech_started' || type === 'speech_ended'
          ? [type]
          : [];
      }) ?? [];
    assert.deepEqual(controlTypes, []);
    assert.ok(environment.sockets[0]?.sent.some((value) => value instanceof ArrayBuffer));

    await adapter.stop();
    adapter.dispose();
  } finally {
    environment.restore();
  }
});

test('remote PCM adapter selects the configured local input device', async () => {
  const environment = installRemoteBrowserEnvironment();
  try {
    const adapter = createRemotePcmVoiceAdapter({
      audioMode: 'baseline',
      audioInputDeviceId: 'local-device-only',
      onEvent: () => undefined,
    });
    const startPromise = adapter.start();
    await waitForRemoteCondition(() => environment.worklets.length === 1);
    environment.worklets[0]!.emit(makePcmChunk(0.1));
    assert.equal(await startPromise, true);

    const audioConstraints = environment.lastGetUserMediaConstraints?.audio;
    assert.deepEqual(
      typeof audioConstraints === 'object' && audioConstraints !== null
        ? (audioConstraints as MediaTrackConstraints).deviceId
        : undefined,
      { exact: 'local-device-only' },
    );
    await adapter.stop();
    adapter.dispose();
  } finally {
    environment.restore();
  }
});

test('remote PCM adapter falls back to ScriptProcessor when AudioWorklet stays silent', async () => {
  const environment = installRemoteBrowserEnvironment({ timerScale: 0.01 });
  try {
    const events: Array<{ type: string; code?: string }> = [];
    const health: Array<{ engine: string | null; status: string }> = [];
    const adapter = createRemotePcmVoiceAdapter({
      audioMode: 'baseline',
      onEvent: (event) => events.push(event),
      onDiagnostic: (diagnostic) => {
        if (diagnostic.type !== 'capture_health') return;
        health.push({
          engine: diagnostic.health.engine,
          status: diagnostic.health.status,
        });
      },
    });

    const startPromise = adapter.start();
    await waitForRemoteCondition(
      () => environment.scripts.length === 1,
      FIRST_PCM_FRAME_TIMEOUT_MS * 2,
    );
    environment.scripts[0]!.emit([new Float32Array(12_000).fill(0.1)]);

    assert.equal(await startPromise, true);
    assert.equal(health.at(-1)?.engine, 'script-processor');
    assert.equal(health.at(-1)?.status, 'ready');
    assert.ok(events.some((event) => event.type === 'listening_started'));
    assert.ok(environment.sockets[0]?.sent.some((value) => value instanceof ArrayBuffer));

    await adapter.stop();
    adapter.dispose();
  } finally {
    environment.restore();
  }
});

test('remote PCM adapter reports silent capture when neither engine emits a frame', async () => {
  const environment = installRemoteBrowserEnvironment({ timerScale: 0.01 });
  try {
    const events: Array<{ type: string; code?: string }> = [];
    const adapter = createRemotePcmVoiceAdapter({
      audioMode: 'baseline',
      onEvent: (event) => events.push(event),
    });

    assert.equal(await adapter.start(), false);
    assert.equal(events.at(-1)?.type, 'recognition_failed');
    assert.equal(events.at(-1)?.code, 'audio-capture-silent');
    await adapter.stop();
  } finally {
    environment.restore();
  }
});

test('remote PCM adapter retries transient startup silence once before reporting failure', async () => {
  const environment = installRemoteBrowserEnvironment({ timerScale: 0.01 });
  try {
    const events: Array<{ type: string; code?: string }> = [];
    const adapter = createRemotePcmVoiceAdapter({
      audioMode: 'baseline',
      onEvent: (event) => events.push(event),
    });

    const startPromise = adapter.start();
    await waitForRemoteCondition(() => environment.worklets.length === 1);
    await waitForRemoteCondition(() => environment.worklets.length === 2);
    environment.worklets[1]!.emit(makePcmChunk(0.1));

    assert.equal(await startPromise, true);
    assert.equal(environment.getUserMediaCalls, 2);
    assert.equal(events.filter((event) => event.type === 'recognition_failed').length, 0);
    assert.equal(
      events.filter((event) => event.type === 'listening_started').length,
      1,
    );
    await adapter.stop();
  } finally {
    environment.restore();
  }
});

test('remote PCM adapter reconnects once after a muted track and ignores duplicate recovery signals', async () => {
  const environment = installRemoteBrowserEnvironment({ timerScale: 0.01 });
  try {
    const events: Array<{ type: string; code?: string }> = [];
    const adapter = createRemotePcmVoiceAdapter({
      audioMode: 'baseline',
      onEvent: (event) => events.push(event),
    });

    const startPromise = adapter.start();
    await waitForRemoteCondition(() => environment.worklets.length === 1);
    environment.worklets[0]!.emit(makePcmChunk(0.1));
    assert.equal(await startPromise, true);

    const firstTrack = environment.tracks[0]!;
    firstTrack.muted = true;
    firstTrack.dispatchEvent(new Event('mute'));
    firstTrack.dispatchEvent(new Event('mute'));
    await waitForRemoteCondition(
      () => environment.getUserMediaCalls === 2 && environment.worklets.length === 2,
    );
    environment.worklets[1]!.emit(makePcmChunk(0.1));
    await waitForRemoteCondition(
      () => events.filter((event) => event.type === 'listening_started').length === 2,
    );

    assert.equal(environment.getUserMediaCalls, 2);
    assert.equal(
      events.filter((event) => event.type === 'listening_started').length,
      2,
    );
    await adapter.stop();
  } finally {
    environment.restore();
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

test('RMS VAD maps the selectable endpoint to a shorter hangover', () => {
  assert.deepEqual(AUDIO_ENDPOINT_VALUES, [400, 600]);
  assert.equal(DEFAULT_AUDIO_ENDPOINT_MS, 600);
  assert.equal(DEFAULT_EXHIBITION_MIX_ENDPOINT_MS, 400);
  assert.equal(getEffectiveAudioEndpointMs('exhibition-mix', 600), 400);
  assert.equal(getEffectiveAudioEndpointMs('processed', 400), 400);
  assert.equal(getEffectiveAudioEndpointMs('processed-vad', 600), 600);
  assert.equal(getEffectiveAudioEndpointMs('baseline', 400), 600);
  assert.equal(getVadHangoverChunkCount(400), 2);
  assert.equal(getVadHangoverChunkCount(600), 3);

  const vad = new RmsVad(0.02, {
    hangoverChunkCount: getVadHangoverChunkCount(400),
  });
  vad.process(makePcmChunk(0.08), 100);
  vad.process(makePcmChunk(0.01), 300);
  assert.deepEqual(vad.process(makePcmChunk(0.01), 500).events, [
    { type: 'speech_ended', at: 500 },
  ]);
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

test('barge-in confirmation accepts only content-bearing transcripts', () => {
  assert.equal(isConfirmedBargeInTranscript('今日は雨だった'), true);
  assert.equal(isConfirmedBargeInTranscript('ヴェイリア'), true);
  assert.equal(isConfirmedBargeInTranscript('いや'), true);
  assert.equal(isConfirmedBargeInTranscript('待って'), true);
  assert.equal(isConfirmedBargeInTranscript('うん'), false);
  assert.equal(isConfirmedBargeInTranscript('はい'), false);
  assert.equal(isConfirmedBargeInTranscript('まあ、そんな感じ'), false);
  assert.equal(
    isConfirmedBargeInTranscript('ご視聴ありがとうございました'),
    false,
  );
  assert.equal(isConfirmedBargeInTranscript(''), false);
  assert.equal(isConfirmedBargeInTranscript('あ'.repeat(1_001)), false);
});

test('barge-in during Vayria speech requires a conversational cue', () => {
  const speakingOptions = { requireConversationalCue: true } as const;

  assert.equal(
    isConfirmedBargeInTranscript('今日は雨だった', speakingOptions),
    false,
  );
  assert.equal(
    isConfirmedBargeInTranscript('ヴェイリア…', speakingOptions),
    true,
  );
  assert.equal(
    isConfirmedBargeInTranscript('ベイリア、聞こえる？', speakingOptions),
    true,
  );
  assert.equal(
    isConfirmedBargeInTranscript('ヴェイリアはどう思う？', speakingOptions),
    true,
  );
  assert.equal(
    isConfirmedBargeInTranscript('ヴェイリアX', speakingOptions),
    false,
  );
  assert.equal(isConfirmedBargeInTranscript('待って', speakingOptions), true);
  assert.equal(isConfirmedBargeInTranscript('いや、それ違う', speakingOptions), true);
  assert.equal(
    isConfirmedBargeInTranscript('ご視聴ありがとうございました', speakingOptions),
    false,
  );
});

test('busy-turn interruption requires a content-bearing finalized transcript', () => {
  assert.equal(shouldInterruptBusyTurn(false, true, false), false);
  assert.equal(shouldInterruptBusyTurn(false, false, true), false);
  assert.equal(shouldInterruptBusyTurn(true, true, false), true);
  assert.equal(shouldInterruptBusyTurn(true, false, true), true);
  assert.equal(shouldInterruptBusyTurn(true, false, false), false);
});

test('barge-in reducer separates candidate ducking from confirmed interruption', () => {
  assert.deepEqual(
    reduceBargeIn('idle', { type: 'speech_started', ttsPlaying: false }),
    { state: 'idle', effects: [] },
  );

  const candidate = reduceBargeIn('idle', {
    type: 'speech_started',
    ttsPlaying: true,
  });
  assert.deepEqual(candidate, {
    state: 'candidate',
    effects: ['duck'],
    reason: 'barge-in-candidate',
  });
  assert.deepEqual(
    reduceBargeIn('candidate', {
      type: 'speech_started',
      ttsPlaying: true,
    }),
    { state: 'candidate', effects: [] },
  );

  assert.deepEqual(
    reduceBargeIn('candidate', {
      type: 'transcript_finalized',
      accepted: true,
    }),
    {
      state: 'confirmed',
      effects: ['interrupt', 'restore'],
      reason: 'confirmed-barge-in',
    },
  );
  assert.deepEqual(
    reduceBargeIn('candidate', {
      type: 'transcript_finalized',
      accepted: false,
    }),
    {
      state: 'restored',
      effects: ['restore'],
      reason: 'candidate-rejected',
    },
  );
  assert.deepEqual(
    reduceBargeIn('candidate', { type: 'timeout' }),
    { state: 'restored', effects: ['restore'], reason: 'timeout' },
  );
  assert.deepEqual(
    reduceBargeIn('candidate', { type: 'recognition_failed' }),
    {
      state: 'restored',
      effects: ['restore'],
      reason: 'recognition-failed',
    },
  );
  assert.deepEqual(
    reduceBargeIn('candidate', { type: 'recognition_stopped' }),
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
      state: 'candidate',
      effects: ['duck'],
      reason: 'barge-in-candidate',
    },
  );
});

test('barge-in keeps a candidate after TTS stops until final text arrives', () => {
  const candidate = reduceBargeIn('idle', {
    type: 'speech_started',
    ttsPlaying: true,
  });
  const ttsStopped = reduceBargeIn(candidate.state, {
    type: 'tts_stopped',
  });

  assert.deepEqual(ttsStopped, {
    state: 'candidate',
    effects: ['restore'],
    reason: 'tts-stopped',
  });
  assert.deepEqual(
    reduceBargeIn(ttsStopped.state, {
      type: 'transcript_finalized',
      accepted: true,
    }),
    {
      state: 'confirmed',
      effects: ['interrupt', 'restore'],
      reason: 'confirmed-barge-in',
    },
  );
});

test('rejected barge-in candidates stay out of the conversation input', () => {
  const rejected = reduceBargeIn('candidate', {
    type: 'transcript_finalized',
    accepted: false,
  });
  const confirmed = reduceBargeIn('candidate', {
    type: 'transcript_finalized',
    accepted: true,
  });

  assert.equal(
    isRejectedBargeInCandidate('segment-1', 'segment-1', rejected),
    true,
  );
  assert.equal(
    isRejectedBargeInCandidate('segment-1', 'segment-1', confirmed),
    false,
  );
  assert.equal(
    isRejectedBargeInCandidate('segment-1', 'segment-2', rejected),
    false,
  );
});

test('interaction timeline distinguishes candidate and confirmed barge-in states', () => {
  const timeline = createInteractionTimeline();
  timeline.record({
    kind: 'barge_in',
    at: 100,
    action: 'duck',
    state: 'candidate',
  });
  timeline.record({
    kind: 'barge_in',
    at: 200,
    action: 'interrupt+restore',
    state: 'confirmed',
  });

  assert.deepEqual(
    timeline.snapshot().map((event) =>
      event.kind === 'barge_in' ? [event.action, event.state] : null,
    ),
    [
      ['duck', 'candidate'],
      ['interrupt+restore', 'confirmed'],
    ],
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

test('Audio Lab defaults to Processed while retaining Mode D for debug selection', () => {
  assert.equal(DEFAULT_AUDIO_INPUT_MODE, 'baseline');
  assert.equal(DEFAULT_AUDIO_LAB_MODE, 'processed');
  assert.equal(BARGE_IN_DUCK_GAIN, 0.25);
  assert.equal(DEFAULT_EXHIBITION_AUDIO_PRESET, 'mild');
  assert.equal(resolveInitialAudioLabMode(true), 'processed');
  assert.equal(resolveInitialAudioLabMode(false), 'baseline');
  assert.equal(resolveInitialAudioLabMode(false, true), 'processed');
  assert.equal(resolveInitialAudioLabMode(false, false), 'baseline');
});

test('Audio endpoint resolves query over environment and defaults to 600ms', () => {
  assert.equal(resolveAudioEndpointMs(null, null), 600);
  assert.equal(resolveAudioEndpointMs(null, '400'), 400);
  assert.equal(resolveAudioEndpointMs('600', '400'), 600);
  assert.equal(resolveAudioEndpointMs('invalid', '400'), 400);
  assert.equal(resolveAudioEndpointMs('invalid', 'invalid'), 600);
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
  assert.equal(getExhibitionAudioPresetConfig('mild').defaultVadThreshold, 0.015);
  assert.equal(getExhibitionAudioPresetConfig('mild').noiseFloorMultiplier, 2.0);
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
  recorder.setTtsPlaying(true, 1_000);
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
    type: 'stt_queued',
    segmentId: 'segment-1',
    at: 1_100,
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
  recorder.setTtsPlaying(false, 1_500);
  recorder.finish();

  const snapshot = recorder.getSnapshot();
  const utterance = snapshot.records.find((record) => record.kind === 'utterance');
  assert.equal(utterance?.kind, 'utterance');
  if (utterance?.kind !== 'utterance') return;
  assert.equal(utterance.rawRecognizedText, 'ご視聴ありがとうございました。');
  assert.equal(utterance.knownHallucinationPhrase, 'ご視聴ありがとうございました');
  assert.equal(utterance.sttLatencyMs, 200);
  assert.equal(utterance.sttQueuedAt, '1970-01-01T00:00:01.100Z');
  assert.equal(utterance.sttObservedAt, '1970-01-01T00:00:01.400Z');
  assert.equal(utterance.sttQueueWaitMs, 100);
  assert.equal(utterance.sttProcessingMs, 200);
  assert.equal(utterance.endpointToResultLatencyMs, 100);
  assert.equal(utterance.speechToResultLatencyMs, 400);
  assert.equal(utterance.audioEndpointMs, 600);
  assert.equal(utterance.audioDurationMs, 300);
  assert.equal(utterance.ttsPlayingDuringUtterance, true);
  assert.equal(snapshot.summary.knownHallucinationCount, 1);
  assert.equal(snapshot.summary.ttsOverlapCount, 1);
  assert.equal(snapshot.summary.ttsActiveDurationMs, 500);
  assert.equal(snapshot.summary.ttsCandidateCount, 1);
  assert.equal(snapshot.summary.ttsAcceptedCount, 1);
  assert.equal(snapshot.summary.ttsVadRejectCount, 0);
  assert.equal(snapshot.summary.ttsNoiseLikeSttCount, 0);
  assert.equal(snapshot.summary.ttsCandidatesPerMinute, 120);
  assert.equal(snapshot.summary.averageSttLatencyMs, 200);
  assert.equal(snapshot.summary.averageSttQueueWaitMs, 100);
  assert.equal(snapshot.summary.averageSttProcessingMs, 200);
  assert.equal(snapshot.summary.averageEndpointToResultLatencyMs, 100);
  assert.equal(snapshot.summary.averageSpeechToResultLatencyMs, 400);
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
  recorder.setTtsPlaying(true, 1_000);
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
    state: 'candidate',
    ttsPlaying: true,
  });
  recorder.handleDiagnostic({
    type: 'barge_in',
    at: 2_000,
    action: 'interrupt',
    state: 'confirmed',
    ttsPlaying: true,
    reason: 'confirmed-barge-in',
  });
  recorder.handleDiagnostic({
    type: 'barge_in',
    at: 2_100,
    action: 'restore',
    state: 'restored',
    ttsPlaying: true,
    reason: 'timeout',
  });
  recorder.setTtsPlaying(false, 2_500);
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
  assert.equal(snapshot.summary.ttsActiveDurationMs, 1_500);
  assert.equal(snapshot.summary.ttsCandidateCount, 2);
  assert.equal(snapshot.summary.ttsAcceptedCount, 1);
  assert.equal(snapshot.summary.ttsVadRejectCount, 1);
  assert.equal(snapshot.summary.ttsCandidatesPerMinute, 80);
  assert.equal(snapshot.summary.bargeInTriggeredCount, 1);
  assert.equal(snapshot.summary.bargeInConfirmedCount, 1);
  assert.equal(snapshot.summary.bargeInRestoredCount, 1);
  assert.equal(snapshot.summary.bargeInTimeoutCount, 1);
  assert.equal(
    snapshot.records.find((record) => record.kind === 'utterance')?.preset,
    'aggressive',
  );
});

test('Voice Lab recorder measures TTS candidates separately from normal overlap', () => {
  const recorder = new VoiceLabRecorder({
    enabled: true,
    mode: 'processed-vad',
    preset: 'mild',
    sessionId: 'vl-tts-candidate-session',
  });
  recorder.start();
  recorder.handleVoiceEvent({
    type: 'speech_started',
    segmentId: 'normal-overlap-segment',
    at: 500,
  });
  recorder.setTtsPlaying(true, 1_000);
  recorder.handleVoiceEvent({
    type: 'speech_ended',
    segmentId: 'normal-overlap-segment',
    at: 1_300,
  });
  recorder.handleVoiceEvent({
    type: 'utterance_finalized',
    segmentId: 'normal-overlap-segment',
    text: '環境音',
    at: 1_400,
  });
  recorder.handleVoiceEvent({
    type: 'speech_started',
    segmentId: 'tts-segment',
    at: 1_500,
  });
  recorder.handleVoiceEvent({
    type: 'speech_ended',
    segmentId: 'tts-segment',
    at: 1_700,
  });
  recorder.handleVoiceEvent({
    type: 'utterance_finalized',
    segmentId: 'tts-segment',
    text: '',
    at: 1_800,
  });
  recorder.handleDiagnostic({
    type: 'vad_rejected',
    at: 1_900,
    candidateDurationMs: 400,
    maxScore: 0.01,
    reason: 'below-threshold',
    noiseFloor: 0.005,
    effectiveThreshold: 0.02,
    vadThreshold: 0.02,
  });
  recorder.setTtsPlaying(false, 2_000);
  recorder.finish();

  const { summary } = recorder.getSnapshot();
  assert.equal(summary.ttsActiveDurationMs, 1_000);
  assert.equal(summary.ttsCandidateCount, 2);
  assert.equal(summary.ttsAcceptedCount, 1);
  assert.equal(summary.ttsVadRejectCount, 1);
  assert.equal(summary.ttsNoiseLikeSttCount, 1);
  assert.equal(summary.ttsCandidatesPerMinute, 120);
  assert.equal(summary.ttsOverlapCount, 2);
  assert.equal(summary.utteranceCount, 2);
  assert.equal(
    summary.byMode['processed-vad'].ttsCandidatesPerMinute,
    120,
  );
});

test('per-minute rate is unavailable without an active TTS duration', () => {
  assert.equal(calculatePerMinuteRate(3, 0), null);
  assert.equal(calculatePerMinuteRate(3, 1_000), 180);
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
      audioEndpointMs: 600 as const,
    };
    assert.deepEqual(readVoiceLabRecord({ record }), record);
    await appendVoiceLabRecord(root, record);
    assert.deepEqual(await readVoiceLabRecords(root, record.sessionId), [record]);
    const runtimeRecord = {
      kind: 'stt_runtime' as const,
      timestamp: '2026-08-22T00:00:00.000Z',
      sessionId: 'vl-store-session',
      mode: 'processed' as const,
      preset: 'mild' as const,
      audioEndpointMs: 600 as const,
      runtime: {
        requestedModel: 'small' as const,
        requestedDevice: 'auto' as const,
        requestedComputeType: 'auto' as const,
        effectiveModel: 'small',
        effectiveDevice: 'cuda',
        effectiveComputeType: 'float16',
        fallbackUsed: false,
        fallbackReason: null,
        modelLoadMs: 842,
      },
    };
    assert.deepEqual(readVoiceLabRecord(runtimeRecord), runtimeRecord);
    const timelineRecord = {
      kind: 'interaction_timeline' as const,
      timestamp: '2026-08-22T00:00:00.000Z',
      sessionId: 'vl-store-session',
      mode: 'exhibition-mix' as const,
      preset: 'mild' as const,
      audioEndpointMs: 600 as const,
      event: {
        kind: 'floor_action' as const,
        action: 'listen' as const,
        at: 1_000,
        segmentId: 'segment-1',
        pendingFragmentCount: 0,
        asrConfidence: null,
      },
    };
    assert.deepEqual(readVoiceLabRecord(timelineRecord), timelineRecord);
    await appendVoiceLabRecord(root, timelineRecord);
    assert.deepEqual(
      await readVoiceLabRecords(root, timelineRecord.sessionId),
      [record, timelineRecord],
    );
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
