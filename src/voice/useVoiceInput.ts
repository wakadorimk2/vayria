import { useCallback, useEffect, useRef, useState } from 'react';
import { createBrowserSpeechRecognitionAdapter } from './browserSpeechRecognition';
import { createRemotePcmVoiceAdapter } from './remotePcmVoiceAdapter';
import type { VoiceInputAdapter } from './voiceAdapter';
import {
  DEFAULT_AUDIO_ENDPOINT_MS,
  DEFAULT_AUDIO_INPUT_MODE,
  DEFAULT_EXHIBITION_AUDIO_PRESET,
  DEFAULT_VAD_THRESHOLD,
  getExhibitionAudioPresetConfig,
  type AudioLabMediaSettings,
  type AudioLabMode,
  type AudioEndpointMs,
  type ExhibitionAudioPreset,
  type SttRuntimeInfo,
  type VoiceCaptureHealth,
  type VoiceInputDiagnostic,
} from './audioLab.js';
import {
  createVoiceInputController,
  INITIAL_VOICE_INPUT_SNAPSHOT,
  type VoiceInputController,
  type VoiceInputEvent,
  type VoiceInputSnapshot,
} from './voiceInput';
import { runtimeConfig, type VoiceInputTransport } from '../runtimeConfig';

export interface UseVoiceInputOptions {
  language?: string;
  transport?: VoiceInputTransport;
  audioMode?: AudioLabMode;
  audioPreset?: ExhibitionAudioPreset;
  audioEndpointMs?: AudioEndpointMs;
  vadThreshold?: number;
  ttsPlaying?: boolean;
  onEvent?: (event: VoiceInputEvent) => void;
  onDiagnostic?: (diagnostic: VoiceInputDiagnostic) => void;
}

function isFatalVoiceError(code: string | null): boolean {
  return (
    code === 'unsupported' ||
    code === 'not-allowed' ||
    code === 'service-not-allowed' ||
    code === 'audio-capture' ||
    code === 'insecure-context' ||
    code === 'audio-worklet-unsupported' ||
    code === 'audio-capture-unsupported' ||
    code === 'audio-capture-silent' ||
    code === 'audio-capture-muted' ||
    code === 'audio-capture-ended' ||
    code === 'audio-context-timeout' ||
    code === 'voice-transport-unavailable' ||
    code === 'voice-transport-closed' ||
    code === 'voice-transport-timeout' ||
    code === 'voice-transport-backpressure' ||
    code === 'stt-unavailable' ||
    code === 'invalid-pcm-frame' ||
    code === 'invalid-voice-event' ||
    code === 'invalid-start-message' ||
    code === 'unsupported-audio-format' ||
    code === 'invalid-control-message' ||
    code === 'message-too-large' ||
    code === 'recognition-failed' ||
    code === 'voice-input-failed'
  );
}

export function useVoiceInput(options: UseVoiceInputOptions = {}) {
  const audioMode = options.audioMode ?? DEFAULT_AUDIO_INPUT_MODE;
  const audioPreset = options.audioPreset ?? DEFAULT_EXHIBITION_AUDIO_PRESET;
  const audioEndpointMs = options.audioEndpointMs ?? DEFAULT_AUDIO_ENDPOINT_MS;
  const vadThreshold =
    options.vadThreshold ??
    getExhibitionAudioPresetConfig(audioPreset).defaultVadThreshold ??
    DEFAULT_VAD_THRESHOLD;
  const optionsRef = useRef(options);
  const controllerRef = useRef<VoiceInputController | null>(null);
  const adapterRef = useRef<VoiceInputAdapter | null>(null);
  const [snapshot, setSnapshot] = useState<VoiceInputSnapshot>(
    INITIAL_VOICE_INPUT_SNAPSHOT,
  );
  const [isEnabled, setIsEnabled] = useState(false);
  const [isSupported, setIsSupported] = useState(false);
  const [lastDiagnostic, setLastDiagnostic] =
    useState<VoiceInputDiagnostic | null>(null);
  const [audioLevel, setAudioLevel] = useState<number | null>(null);
  const [vadScore, setVadScore] = useState<number | null>(null);
  const [noiseFloor, setNoiseFloor] = useState<number | null>(null);
  const [effectiveThreshold, setEffectiveThreshold] = useState<number | null>(
    null,
  );
  const [isVadSpeech, setIsVadSpeech] = useState(false);
  const [isSttProcessing, setIsSttProcessing] = useState(false);
  const [mediaSettings, setMediaSettings] =
    useState<AudioLabMediaSettings | null>(null);
  const [sttRuntime, setSttRuntime] = useState<SttRuntimeInfo | null>(null);
  const [captureHealth, setCaptureHealth] =
    useState<VoiceCaptureHealth | null>(null);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      setIsEnabled(false);
      setIsSttProcessing(false);
      setIsVadSpeech(false);
      setAudioLevel(null);
      setVadScore(null);
      setNoiseFloor(null);
      setEffectiveThreshold(null);
      setLastDiagnostic(null);
      setMediaSettings(null);
      setSttRuntime(null);
      setCaptureHealth(null);
    });

    const controller = controllerRef.current ?? createVoiceInputController();
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setSnapshot);
    const adapterOptions = {
      language: optionsRef.current.language,
      onEvent: (event: VoiceInputEvent) => {
        if (!active) return;
        controller.dispatch(event);
        optionsRef.current.onEvent?.(event);
        switch (event.type) {
          case 'listening_started':
            setIsEnabled(true);
            break;
          case 'speech_started':
            setIsVadSpeech(true);
            break;
          case 'speech_ended':
            setIsVadSpeech(false);
            setIsSttProcessing(true);
            break;
          case 'utterance_finalized':
            setIsSttProcessing(false);
            break;
          case 'recognition_stopped':
            setIsEnabled(false);
            setIsVadSpeech(false);
            setIsSttProcessing(false);
            break;
          case 'recognition_failed':
            if (isFatalVoiceError(event.code)) setIsEnabled(false);
            setIsVadSpeech(false);
            setIsSttProcessing(false);
            break;
          case 'interim_transcript_updated':
            break;
        }
      },
      onDiagnostic: (diagnostic: VoiceInputDiagnostic) => {
        if (!active) return;
        setLastDiagnostic(diagnostic);
        optionsRef.current.onDiagnostic?.(diagnostic);
        switch (diagnostic.type) {
          case 'media_settings':
            setMediaSettings(diagnostic.settings);
            break;
          case 'capture_health':
            setCaptureHealth(diagnostic.health);
            break;
          case 'stt_runtime':
            setSttRuntime(diagnostic.runtime);
            break;
          case 'audio_level':
            setAudioLevel(diagnostic.audioLevel);
            setVadScore(diagnostic.vadScore);
            setNoiseFloor(diagnostic.noiseFloor);
            setEffectiveThreshold(diagnostic.effectiveThreshold);
            setIsVadSpeech(diagnostic.vadSpeech);
            break;
          case 'stt_started':
            setIsSttProcessing(true);
            break;
          case 'stt_observed':
            setIsSttProcessing(false);
            break;
          case 'vad_rejected':
            setIsVadSpeech(false);
            break;
        }
      },
    };
    const configuredTransport =
      optionsRef.current.transport ?? runtimeConfig.voiceTransport;
    const useRemote = audioMode !== 'baseline' || configuredTransport === 'remote';
    const adapter =
      useRemote
        ? createRemotePcmVoiceAdapter({
            ...adapterOptions,
            audioMode,
            audioPreset:
              optionsRef.current.audioPreset ?? DEFAULT_EXHIBITION_AUDIO_PRESET,
            audioEndpointMs,
            vadThreshold:
              optionsRef.current.vadThreshold ??
              getExhibitionAudioPresetConfig(
                optionsRef.current.audioPreset ?? DEFAULT_EXHIBITION_AUDIO_PRESET,
              ).defaultVadThreshold,
            diagnostics: runtimeConfig.audioLabEnabled,
          })
        : createBrowserSpeechRecognitionAdapter(adapterOptions);
    adapterRef.current = adapter;
    adapter.setTtsPlaying?.(Boolean(optionsRef.current.ttsPlaying));
    setIsSupported(adapter.isSupported);

    if (!adapter.isSupported) {
      controller.dispatch({
        type: 'recognition_failed',
        code: adapter.supportErrorCode ?? 'unsupported',
        at: Date.now(),
      });
    }

    return () => {
      active = false;
      unsubscribe();
      adapter.dispose();
      adapterRef.current = null;
    };
  }, [audioMode, audioPreset, audioEndpointMs]);

  useEffect(() => {
    adapterRef.current?.setVadThreshold?.(vadThreshold);
  }, [vadThreshold]);

  useEffect(() => {
    adapterRef.current?.setTtsPlaying?.(Boolean(options.ttsPlaying));
  }, [options.ttsPlaying]);

  const start = useCallback(async () => {
    const adapter = adapterRef.current;
    if (!adapter) return false;
    return adapter.start();
  }, []);

  const stop = useCallback(async () => {
    await adapterRef.current?.stop();
    setIsEnabled(false);
  }, []);

  return {
    errorCode: snapshot.errorCode,
    isEnabled,
    isSupported,
    lastDiagnostic,
    audioLevel,
    vadScore,
    noiseFloor,
    effectiveThreshold,
    isVadSpeech,
    isSttProcessing,
    mediaSettings,
    sttRuntime,
    captureHealth,
    phase: snapshot.phase,
    start,
    stop,
    transcript: snapshot.transcript,
  };
}
