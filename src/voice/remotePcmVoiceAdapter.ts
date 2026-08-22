import type {
  VoiceInputAdapter,
  VoiceInputAdapterOptions,
} from './voiceAdapter.js';
import {
  PCM_CHANNEL_COUNT,
  PCM_CHUNK_BYTES,
  PCM_CHUNK_DURATION_MS,
  PCM_TARGET_SAMPLE_RATE,
} from './pcm16.js';
import type { VoiceInputEvent } from './voiceInput.js';

const SOCKET_OPEN_TIMEOUT_MS = 8_000;
const STOP_GRACE_PERIOD_MS = 250;
const MAX_SOCKET_BUFFERED_BYTES = 512 * 1024;

interface RemotePcmVoiceAdapterOptions extends VoiceInputAdapterOptions {
  webSocketUrl?: string;
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

function readSupportErrorCode(): string | null {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') {
    return 'unsupported';
  }
  if (!window.isSecureContext) return 'insecure-context';
  if (!navigator.mediaDevices?.getUserMedia) return 'unsupported';
  if (typeof WebSocket !== 'function') return 'unsupported';
  const AudioContextConstructor = readAudioContextConstructor();
  if (!AudioContextConstructor || typeof AudioWorkletNode !== 'function') {
    return 'audio-worklet-unsupported';
  }
  return null;
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
  let disposed = false;
  let enabled = false;
  let mediaStream: MediaStream | null = null;
  let audioContext: AudioContext | null = null;
  let sourceNode: MediaStreamAudioSourceNode | null = null;
  let captureNode: AudioWorkletNode | null = null;
  let zeroGainNode: GainNode | null = null;
  let socket: WebSocket | null = null;
  let stopPromise: Promise<void> | null = null;
  let stoppedEventSent = false;

  const emit = (event: VoiceInputEvent) => options.onEvent(event);

  const emitStoppedOnce = () => {
    if (stoppedEventSent) return;
    stoppedEventSent = true;
    emit({ type: 'recognition_stopped', at: now() });
  };

  const closeResources = async () => {
    const currentSocket = socket;
    socket = null;
    captureNode?.port.close();
    captureNode?.disconnect();
    sourceNode?.disconnect();
    zeroGainNode?.disconnect();
    captureNode = null;
    sourceNode = null;
    zeroGainNode = null;
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;
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

  const fail = (code: string) => {
    enabled = false;
    emit({ type: 'recognition_failed', code, at: now() });
    void closeResources();
  };

  const sendBinaryFrame = (data: unknown) => {
    if (!enabled) return;
    if (!(data instanceof ArrayBuffer)) return;
    const currentSocket = socket;
    if (!currentSocket || currentSocket.readyState !== WebSocket.OPEN) {
      fail('voice-transport-closed');
      return;
    }
    if (data.byteLength !== PCM_CHUNK_BYTES) {
      fail('invalid-pcm-frame');
      return;
    }
    if (currentSocket.bufferedAmount > MAX_SOCKET_BUFFERED_BYTES) {
      fail('voice-transport-backpressure');
      return;
    }
    currentSocket.send(data);
  };

  const start = async (): Promise<boolean> => {
    if (disposed || supportErrorCode !== null || !AudioContextConstructor) {
      if (supportErrorCode) emit({ type: 'recognition_failed', code: supportErrorCode, at: now() });
      return false;
    }
    if (enabled) return true;

    enabled = true;
    stoppedEventSent = false;
    try {
      audioContext = new AudioContextConstructor();
      if (!audioContext.audioWorklet) {
        throw new Error('audio-worklet-unsupported');
      }
      await audioContext.resume();
      mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true },
        video: false,
      });
      await audioContext.audioWorklet.addModule(
        new URL('./pcmCaptureWorklet.js', import.meta.url),
      );

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
        if (!voiceEvent) {
          fail('invalid-voice-event');
          return;
        }
        if (voiceEvent.type === 'recognition_stopped') emitStoppedOnce();
        if (voiceEvent.type === 'recognition_failed') {
          enabled = false;
          void closeResources();
        }
        emit(voiceEvent);
      };
      nextSocket.onerror = () => {
        if (enabled) fail('voice-transport-unavailable');
      };
      nextSocket.onclose = () => {
        if (enabled) fail('voice-transport-closed');
      };
      await waitForSocketOpen(nextSocket);
      nextSocket.send(
        JSON.stringify({
          type: 'start',
          language: options.language ?? 'ja-JP',
          sampleRate: PCM_TARGET_SAMPLE_RATE,
          channels: PCM_CHANNEL_COUNT,
          format: 'pcm_s16le',
          chunkMs: PCM_CHUNK_DURATION_MS,
        } satisfies VoiceStartMessage),
      );

      captureNode = new AudioWorkletNode(audioContext, 'vayria-pcm-capture', {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
        processorOptions: {
          inputSampleRate: audioContext.sampleRate,
          targetSampleRate: PCM_TARGET_SAMPLE_RATE,
          chunkSamples: PCM_TARGET_SAMPLE_RATE * (PCM_CHUNK_DURATION_MS / 1_000),
        },
      });
      captureNode.port.onmessage = (event: MessageEvent<unknown>) => {
        sendBinaryFrame(event.data);
      };
      sourceNode = audioContext.createMediaStreamSource(mediaStream);
      zeroGainNode = audioContext.createGain();
      zeroGainNode.gain.value = 0;
      sourceNode.connect(captureNode);
      captureNode.connect(zeroGainNode);
      zeroGainNode.connect(audioContext.destination);
      return true;
    } catch (error) {
      enabled = false;
      const code = error instanceof Error ? error.message : 'voice-input-failed';
      emit({ type: 'recognition_failed', code, at: now() });
      await closeResources();
      return false;
    }
  };

  const stop = async () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      enabled = false;
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
    dispose() {
      if (disposed) return;
      disposed = true;
      void stop();
    },
  };
}
