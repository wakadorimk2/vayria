import { useCallback, useEffect, useRef, useState } from 'react';
import { createBrowserSpeechRecognitionAdapter } from './browserSpeechRecognition';
import { createRemotePcmVoiceAdapter } from './remotePcmVoiceAdapter';
import type { VoiceInputAdapter } from './voiceAdapter';
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
  onEvent?: (event: VoiceInputEvent) => void;
}

function isFatalVoiceError(code: string | null): boolean {
  return (
    code === 'unsupported' ||
    code === 'not-allowed' ||
    code === 'service-not-allowed' ||
    code === 'audio-capture' ||
    code === 'insecure-context' ||
    code === 'audio-worklet-unsupported' ||
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
  const optionsRef = useRef(options);
  const controllerRef = useRef<VoiceInputController | null>(null);
  const adapterRef = useRef<VoiceInputAdapter | null>(null);
  const [snapshot, setSnapshot] = useState<VoiceInputSnapshot>(
    INITIAL_VOICE_INPUT_SNAPSHOT,
  );
  const [isEnabled, setIsEnabled] = useState(false);
  const [isSupported, setIsSupported] = useState(false);

  useEffect(() => {
    optionsRef.current = options;
  }, [options]);

  useEffect(() => {
    const controller = controllerRef.current ?? createVoiceInputController();
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(setSnapshot);
    const adapterOptions = {
      language: optionsRef.current.language,
      onEvent: (event: VoiceInputEvent) => {
        controller.dispatch(event);
        optionsRef.current.onEvent?.(event);
        if (event.type === 'listening_started') {
          setIsEnabled(true);
        }
        if (event.type === 'recognition_stopped') {
          setIsEnabled(false);
        }
        if (
          event.type === 'recognition_failed' &&
          isFatalVoiceError(event.code)
        ) {
          setIsEnabled(false);
        }
      },
    };
    const adapter =
      (optionsRef.current.transport ?? runtimeConfig.voiceTransport) ===
      'remote'
        ? createRemotePcmVoiceAdapter(adapterOptions)
        : createBrowserSpeechRecognitionAdapter(adapterOptions);
    adapterRef.current = adapter;
    setIsSupported(adapter.isSupported);

    if (!adapter.isSupported) {
      controller.dispatch({
        type: 'recognition_failed',
        code: adapter.supportErrorCode ?? 'unsupported',
        at: Date.now(),
      });
    }

    return () => {
      unsubscribe();
      adapter.dispose();
      adapterRef.current = null;
    };
  }, []);

  const start = useCallback(async () => {
    const adapter = adapterRef.current;
    if (!adapter) return false;
    const started = await adapter.start();
    if (started) setIsEnabled(true);
    return started;
  }, []);

  const stop = useCallback(async () => {
    await adapterRef.current?.stop();
    setIsEnabled(false);
  }, []);

  return {
    errorCode: snapshot.errorCode,
    isEnabled,
    isSupported,
    phase: snapshot.phase,
    start,
    stop,
    transcript: snapshot.transcript,
  };
}
