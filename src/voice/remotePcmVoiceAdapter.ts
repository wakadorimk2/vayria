import type {
  VoiceInputAdapter,
  VoiceInputAdapterOptions,
} from './voiceAdapter.js';
import {
  PCM_CHANNEL_COUNT,
  PCM_CHUNK_BYTES,
  PCM_CHUNK_DURATION_MS,
  PCM_TARGET_SAMPLE_RATE,
  StreamingPcm16Encoder,
} from './pcm16.js';
import type { VoiceInputEvent } from './voiceInput.js';
import {
  AUDIO_PROCESSING_CONSTRAINTS,
  DEFAULT_AUDIO_ENDPOINT_MS,
  DEFAULT_AUDIO_INPUT_MODE,
  DEFAULT_EXHIBITION_AUDIO_PRESET,
  DEFAULT_VAD_THRESHOLD,
  getEffectiveAudioEndpointMs,
  getExhibitionAudioPresetConfig,
  isVoiceInputDiagnostic as isAudioLabVoiceInputDiagnostic,
  isSttRuntimeInfo,
  sanitizeMediaTrackSettings,
  type AudioLabMediaSettings,
  type AudioLabMode,
  type AudioEndpointMs,
  type ExhibitionAudioPreset,
  type VoiceCaptureEngine,
  type VoiceCaptureHealth,
  type VoiceCaptureHealthStatus,
  type VoiceInputDiagnostic,
} from './audioLab.js';
import { AdaptiveRmsVad } from './adaptiveRmsVad.js';
import {
  getVadHangoverChunkCount,
  RmsVad,
  calculatePcm16Rms,
} from './rmsVad.js';

const SOCKET_OPEN_TIMEOUT_MS = 8_000;
const STOP_GRACE_PERIOD_MS = 250;
const MAX_SOCKET_BUFFERED_BYTES = 512 * 1024;
// A 200 ms PCM chunk normally arrives well below this limit.
// Keep the fallback and one startup retry responsive on iPadOS Standalone.
export const FIRST_PCM_FRAME_TIMEOUT_MS = 600;
const AUDIO_CONTEXT_RESUME_TIMEOUT_MS = 1_500;
const SCRIPT_PROCESSOR_BUFFER_SIZE = 4_096;
const MAX_CAPTURE_RECOVERY_ATTEMPTS = 1;
const INITIAL_CAPTURE_RETRY_ATTEMPTS = 1;
const INITIAL_CAPTURE_RETRY_DELAY_MS = 100;

interface RemotePcmVoiceAdapterOptions extends VoiceInputAdapterOptions {
  webSocketUrl?: string;
  audioMode?: AudioLabMode;
  audioPreset?: ExhibitionAudioPreset;
  audioEndpointMs?: AudioEndpointMs;
  vadThreshold?: number;
  diagnostics?: boolean;
}

interface WindowWithWebkitAudioContext extends Window {
  AudioContext?: typeof AudioContext;
  webkitAudioContext?: typeof AudioContext;
}

interface VoiceStartMessage {
  type: 'start';
  language: string;
  sampleRate: number;
  channels: number;
  format: 'pcm_s16le';
  chunkMs: number;
  endSilenceMs?: AudioEndpointMs;
  diagnostics?: boolean;
}

function now(): number {
  return Date.now();
}

function readAudioContextConstructor(): typeof AudioContext | null {
  if (typeof window === 'undefined') return null;
  const audioWindow = window as WindowWithWebkitAudioContext;
  return audioWindow.AudioContext ?? audioWindow.webkitAudioContext ?? null;
}

function readWebSocketUrl(override?: string): string | null {
  if (typeof window === 'undefined') return override ?? null;
  const url = new URL(override ?? '/api/voice-stream', window.location.href);
  if (!override) {
    url.protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  }
  return url.toString();
}

function readAudioConstraints(
  audioMode: AudioLabMode,
  audioPreset: ExhibitionAudioPreset,
): MediaTrackConstraints {
  if (audioMode === 'exhibition-mix') {
    return getExhibitionAudioPresetConfig(audioPreset).requestedConstraints;
  }

  if (audioMode === DEFAULT_AUDIO_INPUT_MODE) {
    return { echoCancellation: true };
  }

  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
  };
}

function readMediaTrackSettings(
  stream: MediaStream,
  requested: MediaTrackConstraints,
): AudioLabMediaSettings {
  const track = stream.getAudioTracks()[0];
  const supportedConstraints =
    typeof navigator.mediaDevices.getSupportedConstraints === 'function'
      ? navigator.mediaDevices.getSupportedConstraints()
      : {};
  const supported = Object.fromEntries(
    AUDIO_PROCESSING_CONSTRAINTS.flatMap((name) =>
      typeof supportedConstraints[name] === 'boolean'
        ? [[name, supportedConstraints[name]]]
        : [],
    ),
  ) as AudioLabMediaSettings['supported'];

  let applied: AudioLabMediaSettings['applied'] = {};
  try {
    applied = sanitizeMediaTrackSettings(track?.getSettings());
  } catch {
    applied = {};
  }

  return {
    requested: Object.fromEntries(
      AUDIO_PROCESSING_CONSTRAINTS.flatMap((name) =>
        typeof requested[name] === 'boolean'
          ? [[name, requested[name] as boolean]]
          : [],
      ),
    ) as AudioLabMediaSettings['requested'],
    supported,
    applied,
  };
}

function readSupportErrorCode(): string | null {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return 'unsupported';
  }
  if (!window.isSecureContext) return 'insecure-context';
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  if (typeof WebSocket !== 'function') return 'unsupported';
  const AudioContextConstructor = readAudioContextConstructor();
  if (!AudioContextConstructor) return 'audio-capture-unsupported';
  const canUseScriptProcessor =
    typeof AudioContextConstructor.prototype?.createScriptProcessor ===
    'function';
  if (!canUseScriptProcessor && typeof AudioWorkletNode !== 'function') {
    return 'audio-capture-unsupported';
  }
  return null;
}

export function isPcm16Chunk(value: unknown): value is ArrayBuffer {
  return value instanceof ArrayBuffer && value.byteLength === PCM_CHUNK_BYTES;
}

function waitWithTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  timeoutCode: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timeoutId =
      typeof window === 'undefined'
        ? null
        : window.setTimeout(() => {
            if (settled) return;
            settled = true;
            reject(new Error(timeoutCode));
          }, timeoutMs);
    const clear = () => {
      if (timeoutId !== null && typeof window !== 'undefined') {
        window.clearTimeout(timeoutId);
      }
    };
    promise.then(
      (value) => {
        if (settled) return;
        settled = true;
        clear();
        resolve(value);
      },
      (error: unknown) => {
        if (settled) return;
        settled = true;
        clear();
        reject(error);
      },
    );
  });
}

function waitForDelay(delayMs: number): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window === 'undefined') {
      resolve();
      return;
    }
    window.setTimeout(resolve, delayMs);
  });
}

function isRetryableInitialCaptureFailure(code: string): boolean {
  return (
    code === 'audio-capture-silent' ||
    code === 'audio-capture-muted' ||
    code === 'audio-capture-ended' ||
    code === 'audio-context-timeout'
  );
}

function isVoiceInputEvent(value: unknown): value is VoiceInputEvent {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== 'string' || typeof record.at !== 'number') {
    return false;
  }
  if (
    record.type === 'listening_started' ||
    record.type === 'recognition_stopped'
  ) {
    return Number.isFinite(record.at);
  }
  if (record.type === 'recognition_failed') {
    return typeof record.code === 'string' && Number.isFinite(record.at);
  }
  if (
    record.type === 'speech_started' ||
    record.type === 'speech_ended' ||
    record.type === 'interim_transcript_updated' ||
    record.type === 'utterance_finalized'
  ) {
    return (
      typeof record.segmentId === 'string' &&
      (record.type !== 'utterance_finalized' || typeof record.text === 'string') &&
      (record.type !== 'interim_transcript_updated' ||
        typeof record.text === 'string') &&
      Number.isFinite(record.at)
    );
  }
  return false;
}

function normalizeVoiceInputEvent(value: unknown): VoiceInputEvent | null {
  if (!isVoiceInputEvent(value)) return null;
  return value;
}

function isVoiceInputDiagnostic(value: unknown): value is VoiceInputDiagnostic {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.type !== 'string' || typeof record.at !== 'number') {
    return false;
  }
  if (record.type === 'capture_health') {
    return isAudioLabVoiceInputDiagnostic(value);
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
      (record.filterReason === undefined ||
        typeof record.filterReason === 'string') &&
      Number.isFinite(record.at)
    );
  }
  return false;
}

function normalizeVoiceInputDiagnostic(
  value: unknown,
): VoiceInputDiagnostic | null {
  if (!isVoiceInputDiagnostic(value)) return null;
  return value;
}

function waitForSocketOpen(socket: WebSocket): Promise<void> {
  return new Promise((resolve, reject) => {
    let timeoutId: number | null = null;
    const clear = () => {
      if (timeoutId !== null && typeof window !== 'undefined') {
        window.clearTimeout(timeoutId);
      }
      socket.removeEventListener('open', handleOpen);
      socket.removeEventListener('error', handleError);
      socket.removeEventListener('close', handleClose);
    };
    const handleOpen = () => {
      clear();
      resolve();
    };
    const handleError = () => {
      clear();
      reject(new Error('voice-transport-unavailable'));
    };
    const handleClose = () => {
      clear();
      reject(new Error('voice-transport-closed'));
    };

    socket.addEventListener('open', handleOpen);
    socket.addEventListener('error', handleError);
    socket.addEventListener('close', handleClose);
    if (typeof window !== 'undefined') {
      timeoutId = window.setTimeout(() => {
        clear();
        reject(new Error('voice-transport-timeout'));
      }, SOCKET_OPEN_TIMEOUT_MS);
    }
  });
}

export function createRemotePcmVoiceAdapter(
  options: RemotePcmVoiceAdapterOptions,
): VoiceInputAdapter {
  const supportErrorCode = readSupportErrorCode();
  const AudioContextConstructor = readAudioContextConstructor();
  const audioMode = options.audioMode ?? DEFAULT_AUDIO_INPUT_MODE;
  const audioPreset = options.audioPreset ?? DEFAULT_EXHIBITION_AUDIO_PRESET;
  const audioEndpointMs = options.audioEndpointMs ?? DEFAULT_AUDIO_ENDPOINT_MS;
  const presetConfig = getExhibitionAudioPresetConfig(audioPreset);
  const requestedAudioConstraints = readAudioConstraints(audioMode, audioPreset);
  const usesSelectableEndpoint =
    audioMode === 'processed' ||
    audioMode === 'processed-vad' ||
    audioMode === 'exhibition-mix';
  const endpointMs = usesSelectableEndpoint
    ? getEffectiveAudioEndpointMs(audioMode, audioEndpointMs)
    : DEFAULT_AUDIO_ENDPOINT_MS;
  const hangoverChunkCount = getVadHangoverChunkCount(endpointMs);
  const rmsVad =
    audioMode === 'processed-vad'
      ? new RmsVad(options.vadThreshold ?? DEFAULT_VAD_THRESHOLD, {
          hangoverChunkCount,
        })
      : null;
  const adaptiveRmsVad =
    audioMode === 'exhibition-mix' && presetConfig.browserGateEnabled
      ? new AdaptiveRmsVad(options.vadThreshold ?? presetConfig.defaultVadThreshold, {
          noiseFloorMultiplier: presetConfig.noiseFloorMultiplier,
          hangoverChunkCount: getVadHangoverChunkCount(endpointMs),
        })
      : null;
  const activeVad = rmsVad ?? adaptiveRmsVad;

  let disposed = false;
  let enabled = false;
  let mediaStream: MediaStream | null = null;
  let audioTrack: MediaStreamTrack | null = null;
  let audioContext: AudioContext | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let captureNode: AudioWorkletNode | null = null;
  let scriptProcessorNode: ScriptProcessorNode | null = null;
  let zeroGainNode: GainNode | null = null;
  let socket: WebSocket | null = null;
  let serverStarted = false;
  let pendingFirstPcmFrame: ArrayBuffer | null = null;
  let captureGraphGeneration = 0;
  let firstPcmFrameSeen = false;
  let firstPcmFrameResolver: ((seen: boolean) => void) | null = null;
  let firstPcmFrameTimeoutId: number | null = null;
  let captureEngine: VoiceCaptureEngine | null = null;
  let captureFrameCount = 0;
  let lastPcmAt: number | null = null;
  let recoveryAttempts = 0;
  let recoveryPromise: Promise<void> | null = null;
  let startPromise: Promise<boolean> | null = null;
  let stopPromise: Promise<void> | null = null;
  let stoppedEventSent = false;
  let failureEmitted = false;
  let lifecycleListenersAttached = false;
  let trackStateListener: ((event: Event) => void) | null = null;
  let contextStateListener: (() => void) | null = null;

  const emit = (event: VoiceInputEvent) => options.onEvent(event);
  const emitDiagnostic = (diagnostic: VoiceInputDiagnostic) =>
    options.onDiagnostic?.(diagnostic);

  const readCaptureHealth = (
    status: VoiceCaptureHealthStatus,
    errorCode: string | null = null,
  ): VoiceCaptureHealth => {
    const contextState = audioContext?.state;
    return {
      engine: captureEngine,
      audioContextState:
        contextState === undefined
          ? 'unavailable'
          : contextState === 'closed'
            ? 'closed'
            : contextState === 'running'
              ? 'running'
              : 'suspended',
      trackMuted: audioTrack?.muted ?? null,
      trackReadyState: audioTrack?.readyState ?? 'unavailable',
      pcmFrameCount: captureFrameCount,
      lastPcmAt,
      status,
      errorCode,
    };
  };

  const emitCaptureHealth = (
    status: VoiceCaptureHealthStatus,
    errorCode: string | null = null,
  ) => {
    emitDiagnostic({ type: 'capture_health', at: now(), health: readCaptureHealth(status, errorCode) });
  };

  const emitStoppedOnce = () => {
    if (stoppedEventSent) return;
    stoppedEventSent = true;
    emit({ type: 'recognition_stopped', at: now() });
  };

  const clearFirstPcmFrameProbe = () => {
    if (firstPcmFrameTimeoutId !== null && typeof window !== 'undefined') {
      window.clearTimeout(firstPcmFrameTimeoutId);
    }
    firstPcmFrameTimeoutId = null;
    firstPcmFrameResolver = null;
  };

  const resolveFirstPcmFrameProbe = (seen: boolean) => {
    const resolver = firstPcmFrameResolver;
    clearFirstPcmFrameProbe();
    resolver?.(seen);
  };

  const beginFirstPcmFrameProbe = (): Promise<boolean> => {
    clearFirstPcmFrameProbe();
    firstPcmFrameSeen = false;
    return new Promise((resolve) => {
      firstPcmFrameResolver = resolve;
      if (typeof window !== 'undefined') {
        firstPcmFrameTimeoutId = window.setTimeout(() => {
          resolveFirstPcmFrameProbe(false);
        }, FIRST_PCM_FRAME_TIMEOUT_MS);
      }
    });
  };

  const detachLifecycleListeners = () => {
    if (typeof window !== 'undefined' && lifecycleListenersAttached) {
      window.removeEventListener('pageshow', handleLifecycleEvent);
    }
    if (typeof document !== 'undefined' && lifecycleListenersAttached) {
      document.removeEventListener('visibilitychange', handleLifecycleEvent);
    }
    lifecycleListenersAttached = false;
    if (audioTrack && trackStateListener) {
      audioTrack.removeEventListener('mute', trackStateListener);
      audioTrack.removeEventListener('unmute', trackStateListener);
      audioTrack.removeEventListener('ended', trackStateListener);
    }
    trackStateListener = null;
    if (audioContext && contextStateListener) {
      audioContext.removeEventListener('statechange', contextStateListener);
    }
    contextStateListener = null;
  };

  const disconnectCaptureNodes = () => {
    captureGraphGeneration += 1;
    resolveFirstPcmFrameProbe(false);
    captureNode?.port.close();
    captureNode?.disconnect();
    scriptProcessorNode?.disconnect();
    if (scriptProcessorNode) scriptProcessorNode.onaudioprocess = null;
    sourceNode?.disconnect();
    captureNode = null;
    scriptProcessorNode = null;
    sourceNode = null;
    captureEngine = null;
  };

  const closeResources = async () => {
    detachLifecycleListeners();
    disconnectCaptureNodes();
    const currentSocket = socket;
    socket = null;
    serverStarted = false;
    pendingFirstPcmFrame = null;
    const currentTrack = audioTrack;
    audioTrack = null;
    currentTrack?.stop();
    mediaStream?.getTracks().forEach((track) => {
      if (track !== currentTrack) track.stop();
    });
    mediaStream = null;
    activeVad?.reset();
    zeroGainNode?.disconnect();
    zeroGainNode = null;
    const currentContext = audioContext;
    audioContext = null;
    if (currentSocket) {
      currentSocket.onopen = null;
      currentSocket.onmessage = null;
      currentSocket.onerror = null;
      currentSocket.onclose = null;
      if (
        currentSocket.readyState === WebSocket.OPEN ||
        currentSocket.readyState === WebSocket.CONNECTING
      ) {
        currentSocket.close();
      }
    }
    if (currentContext && currentContext.state !== 'closed') {
      await currentContext.close().catch(() => undefined);
    }
  };

  const emitFailureOnce = (code: string) => {
    if (failureEmitted) return;
    failureEmitted = true;
    emitCaptureHealth('failed', code);
    emit({ type: 'recognition_failed', code, at: now() });
  };

  const fail = (code: string) => {
    if (!enabled) return;
    enabled = false;
    emitFailureOnce(code);
    void closeResources();
  };

  const sendBinaryFrame = (data: unknown) => {
    if (!enabled || !serverStarted) return;
    if (!isPcm16Chunk(data)) {
      fail('invalid-pcm-frame');
      return;
    }
    const currentSocket = socket;
    if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN) {
      fail('voice-transport-closed');
      return;
    }
    if (currentSocket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
      fail('voice-transport-backpressure');
      return;
    }
    currentSocket.send(data);
  };

  const processPcmFrame = (data: ArrayBuffer) => {
    if (!enabled || !serverStarted) return;
    const audioLevel = calculatePcm16Rms(data);
    if (!activeVad) {
      emitDiagnostic({
        type: 'audio_level',
        at: now(),
        audioLevel,
        vadScore: null,
        vadSpeech: false,
        sentToStt: true,
        noiseFloor: null,
        effectiveThreshold: null,
        vadThreshold: null,
      });
      sendBinaryFrame(data);
      return;
    }

    const vadResult = activeVad.process(data, now());
    const noiseFloor = adaptiveRmsVad?.getNoiseFloor() ?? null;
    const effectiveThreshold =
      adaptiveRmsVad?.getEffectiveThreshold() ??
      rmsVad?.getThreshold() ??
      null;
    const vadThreshold =
      adaptiveRmsVad?.getThreshold() ?? rmsVad?.getThreshold() ?? null;
    emitDiagnostic({
      type: 'audio_level',
      at: now(),
      audioLevel,
      vadScore: vadResult.score,
      vadSpeech: vadResult.speechActive,
      sentToStt: vadResult.forwardedChunks.length > 0,
      noiseFloor,
      effectiveThreshold,
      vadThreshold,
    });
    for (const vadEvent of vadResult.events) {
      if (vadEvent.type !== 'rejected') continue;
      emitDiagnostic({
        type: 'vad_rejected',
        at: vadEvent.at,
        candidateDurationMs: vadEvent.candidateDurationMs,
        maxScore: vadEvent.maxScore,
        reason: vadEvent.reason,
        noiseFloor,
        effectiveThreshold,
        vadThreshold,
      });
    }
    for (const forwardedChunk of vadResult.forwardedChunks) {
      sendBinaryFrame(forwardedChunk);
    }
  };

  const handlePcmFrame = (data: unknown, generation: number) => {
    if (!enabled || generation !== captureGraphGeneration) return;
    if (!isPcm16Chunk(data)) {
      fail('invalid-pcm-frame');
      return;
    }
    captureFrameCount += 1;
    lastPcmAt = now();
    if (!firstPcmFrameSeen) {
      firstPcmFrameSeen = true;
      pendingFirstPcmFrame = data.slice(0);
      resolveFirstPcmFrameProbe(true);
      emitCaptureHealth('ready');
    }
    if (!serverStarted) return;
    processPcmFrame(data);
  };

  const ensureBaseGraph = () => {
    if (!audioContext || !mediaStream) {
      throw new Error('audio-capture');
    }
    if (!sourceNode) sourceNode = audioContext.createMediaStreamSource(mediaStream);
    if (!zeroGainNode) {
      zeroGainNode = audioContext.createGain();
      zeroGainNode.gain.value = 0;
      zeroGainNode.connect(audioContext.destination);
    }
  };

  const connectCaptureGraph = async () => {
    const currentContext = audioContext;
    if (!currentContext || !mediaStream) throw new Error('audio-capture');
    ensureBaseGraph();
    const generation = captureGraphGeneration + 1;
    captureGraphGeneration = generation;
    let workletError: unknown = null;

    if (
      currentContext.audioWorklet &&
      typeof AudioWorkletNode === 'function'
    ) {
      try {
        await currentContext.audioWorklet.addModule(
          new URL('./pcmCaptureWorklet.js', import.meta.url),
        );
        captureEngine = 'audio-worklet';
        emitCaptureHealth('probing');
        const firstFramePromise = beginFirstPcmFrameProbe();
        const nextCaptureNode = new AudioWorkletNode(
          currentContext,
          'vayria-pcm-capture',
          {
            numberOfInputs: 1,
            numberOfOutputs: 1,
            outputChannelCount: [1],
            processorOptions: {
              inputSampleRate: currentContext.sampleRate,
              targetSampleRate: PCM_TARGET_SAMPLE_RATE,
              chunkSamples:
                PCM_TARGET_SAMPLE_RATE * (PCM_CHUNK_DURATION_MS / 1_000),
            },
          },
        );
        captureNode = nextCaptureNode;
        nextCaptureNode.port.onmessage = (event: MessageEvent<unknown>) => {
          handlePcmFrame(event.data, generation);
        };
        sourceNode?.connect(nextCaptureNode);
        nextCaptureNode.connect(zeroGainNode!);
        if (await firstFramePromise) return;
        workletError = new Error('audio-capture-silent');
      } catch (error) {
        workletError = error;
      }
      disconnectCaptureNodes();
      if (!enabled) throw new Error('voice-input-failed');
    }

    ensureBaseGraph();
    const scriptGeneration = captureGraphGeneration + 1;
    captureGraphGeneration = scriptGeneration;
    const createScriptProcessor = currentContext.createScriptProcessor;
    if (typeof createScriptProcessor !== 'function') {
      throw new Error(
        workletError ? 'audio-capture-silent' : 'audio-capture-unsupported',
      );
    }

    captureEngine = 'script-processor';
    emitCaptureHealth('probing');
    const firstFramePromise = beginFirstPcmFrameProbe();
    const nextScriptProcessor = createScriptProcessor.call(
      currentContext,
      SCRIPT_PROCESSOR_BUFFER_SIZE,
      1,
      1,
    );
    scriptProcessorNode = nextScriptProcessor;
    const encoder = new StreamingPcm16Encoder(
      currentContext.sampleRate,
      PCM_TARGET_SAMPLE_RATE,
      PCM_TARGET_SAMPLE_RATE * (PCM_CHUNK_DURATION_MS / 1_000),
    );
    nextScriptProcessor.onaudioprocess = (event: AudioProcessingEvent) => {
      try {
        const channels = Array.from(
          { length: event.inputBuffer.numberOfChannels },
          (_, channelIndex) => event.inputBuffer.getChannelData(channelIndex),
        );
        for (const chunk of encoder.push(channels)) {
          handlePcmFrame(chunk, scriptGeneration);
        }
      } catch {
        fail('audio-capture-silent');
      }
    };
    sourceNode?.connect(nextScriptProcessor);
    nextScriptProcessor.connect(zeroGainNode!);
    if (await firstFramePromise) return;
    throw new Error('audio-capture-silent');
  };

  const readCaptureFailureCode = (fallback: string): string => {
    if (audioTrack?.readyState === 'ended') return 'audio-capture-ended';
    if (audioTrack?.muted) return 'audio-capture-muted';
    if (audioContext && audioContext.state !== 'running') {
      return 'audio-context-timeout';
    }
    return fallback;
  };

  const handleLifecycleEvent = () => {
    if (
      !enabled ||
      startPromise ||
      recoveryPromise ||
      (typeof document !== 'undefined' && document.hidden)
    ) {
      return;
    }
    const issue =
      audioTrack?.readyState === 'ended'
        ? 'audio-capture-ended'
        : audioTrack?.muted
          ? 'audio-capture-muted'
          : audioContext && audioContext.state !== 'running'
            ? 'audio-context-timeout'
            : null;
    if (issue) void recoverCapture(issue);
  };

  const attachLifecycleListeners = () => {
    if (lifecycleListenersAttached) return;
    if (typeof window !== 'undefined') {
      window.addEventListener('pageshow', handleLifecycleEvent);
    }
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', handleLifecycleEvent);
    }
    lifecycleListenersAttached = true;
  };

  const attachCaptureStateListeners = () => {
    if (audioTrack) {
      trackStateListener = (event: Event) => {
        if (!enabled) return;
        const code =
          event.type === 'ended'
            ? 'audio-capture-ended'
            : event.type === 'mute'
              ? 'audio-capture-muted'
              : null;
        if (code) {
          emitCaptureHealth('recovering', code);
          if (!startPromise) void recoverCapture(code);
        }
      };
      audioTrack.addEventListener('mute', trackStateListener);
      audioTrack.addEventListener('unmute', trackStateListener);
      audioTrack.addEventListener('ended', trackStateListener);
    }
    if (audioContext) {
      contextStateListener = () => {
        if (!audioContext) return;
        const state = audioContext.state;
        emitCaptureHealth(state === 'running' ? 'ready' : 'recovering',
          state === 'running' ? null : 'audio-context-timeout');
        if (enabled && !startPromise && state === 'closed') {
          void recoverCapture('audio-context-timeout');
        }
      };
      audioContext.addEventListener('statechange', contextStateListener);
    }
    attachLifecycleListeners();
  };

  const createSocket = async (): Promise<WebSocket> => {
    const webSocketUrl = readWebSocketUrl(options.webSocketUrl);
    if (!webSocketUrl) throw new Error('voice-transport-unavailable');
    const nextSocket = new WebSocket(webSocketUrl);
    nextSocket.binaryType = 'arraybuffer';
    socket = nextSocket;
    nextSocket.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        fail('invalid-voice-event');
        return;
      }
      const voiceEvent = normalizeVoiceInputEvent(parsed);
      if (voiceEvent) {
        if (voiceEvent.type === 'recognition_stopped') emitStoppedOnce();
        if (voiceEvent.type === 'recognition_failed') {
          enabled = false;
          failureEmitted = true;
          emitCaptureHealth('failed', voiceEvent.code);
          void closeResources();
        }
        emit(voiceEvent);
        return;
      }

      const diagnostic = normalizeVoiceInputDiagnostic(parsed);
      if (diagnostic) {
        emitDiagnostic(diagnostic);
        return;
      }

      fail('invalid-voice-event');
    };
    nextSocket.onerror = () => {
      if (enabled) fail('voice-transport-unavailable');
    };
    nextSocket.onclose = () => {
      if (enabled) fail('voice-transport-closed');
    };
    await waitForSocketOpen(nextSocket);
    return nextSocket;
  };

  const openResources = async () => {
    if (!AudioContextConstructor) throw new Error('audio-capture-unsupported');
    audioContext = new AudioContextConstructor();
    emitCaptureHealth('probing');
    await waitWithTimeout(
      Promise.resolve(audioContext.resume()),
      AUDIO_CONTEXT_RESUME_TIMEOUT_MS,
      'audio-context-timeout',
    );
    if (audioContext.state !== 'running') {
      throw new Error('audio-context-timeout');
    }
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: requestedAudioConstraints,
      video: false,
    });
    audioTrack = mediaStream.getAudioTracks()[0] ?? null;
    if (!audioTrack) throw new Error('audio-capture');
    emitDiagnostic({
      type: 'media_settings',
      at: now(),
      settings: readMediaTrackSettings(mediaStream, requestedAudioConstraints),
    });
    attachCaptureStateListeners();
    const nextSocket = await createSocket();
    await connectCaptureGraph();
    if (!enabled) throw new Error('voice-input-failed');
    nextSocket.send(
      JSON.stringify({
        type: 'start',
        language: options.language ?? 'ja-JP',
        sampleRate: PCM_TARGET_SAMPLE_RATE,
        channels: PCM_CHANNEL_COUNT,
        format: 'pcm_s16le',
        chunkMs: PCM_CHUNK_DURATION_MS,
        ...(usesSelectableEndpoint ? { endSilenceMs: endpointMs } : {}),
        ...(options.diagnostics ? { diagnostics: true } : {}),
      } satisfies VoiceStartMessage),
    );
    serverStarted = true;
    const firstFrame = pendingFirstPcmFrame;
    pendingFirstPcmFrame = null;
    if (firstFrame) processPcmFrame(firstFrame);
    emitCaptureHealth('ready');
  };

  const recoverCapture = async (reason: string): Promise<void> => {
    if (!enabled || disposed || recoveryPromise) return;
    if (recoveryAttempts >= MAX_CAPTURE_RECOVERY_ATTEMPTS) {
      enabled = false;
      emitFailureOnce(reason);
      await closeResources();
      return;
    }
    recoveryAttempts += 1;
    recoveryPromise = (async () => {
      emitCaptureHealth('recovering', reason);
      await closeResources();
      if (!enabled || disposed) return;
      failureEmitted = false;
      try {
        await openResources();
      } catch (error) {
        if (!enabled || disposed) return;
        enabled = false;
        const code = readCaptureFailureCode(
          error instanceof Error ? error.message : 'voice-input-failed',
        );
        emitFailureOnce(code);
        await closeResources();
      }
    })().finally(() => {
      recoveryPromise = null;
    });
    await recoveryPromise;
  };

  const start = async (): Promise<boolean> => {
    if (disposed || supportErrorCode !== null || !AudioContextConstructor) {
      if (supportErrorCode) {
        emit({ type: 'recognition_failed', code: supportErrorCode, at: now() });
      }
      return false;
    }
    if (startPromise) return startPromise;
    if (enabled) return true;

    enabled = true;
    stoppedEventSent = false;
    failureEmitted = false;
    recoveryAttempts = 0;
    captureFrameCount = 0;
    lastPcmAt = null;
    startPromise = (async () => {
      let retryCount = 0;
      try {
        while (true) {
          try {
            await openResources();
            return true;
          } catch (error) {
            if (!enabled || disposed) {
              await closeResources();
              return false;
            }
            const code = readCaptureFailureCode(
              error instanceof Error ? error.message : 'voice-input-failed',
            );
            await closeResources();
            if (
              retryCount < INITIAL_CAPTURE_RETRY_ATTEMPTS &&
              isRetryableInitialCaptureFailure(code)
            ) {
              retryCount += 1;
              captureFrameCount = 0;
              lastPcmAt = null;
              await waitForDelay(INITIAL_CAPTURE_RETRY_DELAY_MS);
              if (!enabled || disposed) return false;
              continue;
            }
            enabled = false;
            emitFailureOnce(code);
            return false;
          }
        }
      } finally {
        startPromise = null;
      }
    })();
    return startPromise;
  };

  const stop = async () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      enabled = false;
      const pendingStart = startPromise;
      const pendingRecovery = recoveryPromise;
      if (pendingStart || pendingRecovery) await closeResources();
      await pendingStart;
      await pendingRecovery;
      for (const vadEvent of activeVad?.flush(now()) ?? []) {
        if (vadEvent.type !== 'rejected') continue;
        const noiseFloor = adaptiveRmsVad?.getNoiseFloor() ?? null;
        const effectiveThreshold =
          adaptiveRmsVad?.getEffectiveThreshold() ??
          rmsVad?.getThreshold() ??
          null;
        const vadThreshold =
          adaptiveRmsVad?.getThreshold() ?? rmsVad?.getThreshold() ?? null;
        emitDiagnostic({
          type: 'vad_rejected',
          at: vadEvent.at,
          candidateDurationMs: vadEvent.candidateDurationMs,
          maxScore: vadEvent.maxScore,
          reason: vadEvent.reason,
          noiseFloor,
          effectiveThreshold,
          vadThreshold,
        });
      }
      const currentSocket = socket;
      if (currentSocket?.readyState === WebSocket.OPEN) {
        currentSocket.send(JSON.stringify({ type: 'stop' }));
        await new Promise<void>((resolve) => {
          if (typeof window === 'undefined') {
            resolve();
            return;
          }
          window.setTimeout(resolve, STOP_GRACE_PERIOD_MS);
        });
      }
      emitStoppedOnce();
      await closeResources();
      stopPromise = null;
    })();
    return stopPromise;
  };

  return {
    isSupported: supportErrorCode === null,
    supportErrorCode,
    start,
    stop,
    setVadThreshold(value: number) {
      activeVad?.setThreshold(value);
    },
    setTtsPlaying(isPlaying: boolean) {
      adaptiveRmsVad?.setTtsPlaying(isPlaying);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      void stop();
    },
  };
}
