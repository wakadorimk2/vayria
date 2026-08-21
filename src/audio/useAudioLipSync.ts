import { useCallback, useEffect, useRef, useState } from 'react';

const SMOOTHING_FACTOR = 0.5;
const RMS_CEILING = 0.12;

export interface PlayAudioOptions {
  onStart?: () => void;
}

export type PlayAudio = (
  audioData: ArrayBuffer,
  options?: PlayAudioOptions,
) => Promise<void>;

export function useAudioLipSync() {
  const [mouthOpen, setMouthOpen] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const animationFrameRef = useRef(0);
  const smoothedRmsRef = useRef(0);
  const generationRef = useRef(0);

  const prepare = useCallback(() => {
    if (!contextRef.current || contextRef.current.state === 'closed') {
      contextRef.current = new AudioContext();
    }

    if (contextRef.current.state === 'suspended') {
      void contextRef.current.resume().catch(() => {
        // play() retries and reports the error through the conversation flow.
      });
    }
  }, []);

  const clearPlayback = useCallback(() => {
    if (sourceRef.current) {
      try {
        sourceRef.current.stop();
      } catch {
        // The source already stopped.
      }
      sourceRef.current.disconnect();
      sourceRef.current = null;
    }

    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
      animationFrameRef.current = 0;
    }

    analyserRef.current = null;
    smoothedRmsRef.current = 0;
    setMouthOpen(0);
    setIsSpeaking(false);
  }, []);

  const stop = useCallback(() => {
    generationRef.current += 1;
    clearPlayback();
  }, [clearPlayback]);

  const play = useCallback<PlayAudio>(
    async (audioData, options) => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      clearPlayback();

      if (!contextRef.current || contextRef.current.state === 'closed') {
        contextRef.current = new AudioContext();
      }
      const context = contextRef.current;
      if (context.state === 'suspended') {
        await context.resume();
      }

      const decodedAudio = await context.decodeAudioData(audioData.slice(0));
      if (generation !== generationRef.current) return;

      const source = context.createBufferSource();
      const analyser = context.createAnalyser();
      analyser.fftSize = 2048;
      source.buffer = decodedAudio;
      source.connect(analyser);
      analyser.connect(context.destination);
      sourceRef.current = source;
      analyserRef.current = analyser;

      const samples = new Float32Array(analyser.fftSize);
      const updateMouth = () => {
        if (
          generation !== generationRef.current ||
          analyserRef.current !== analyser
        ) {
          return;
        }

        analyser.getFloatTimeDomainData(samples);
        let squaredTotal = 0;
        for (const sample of samples) {
          squaredTotal += sample * sample;
        }
        const rms = Math.sqrt(squaredTotal / samples.length);
        smoothedRmsRef.current =
          smoothedRmsRef.current * SMOOTHING_FACTOR +
          rms * (1 - SMOOTHING_FACTOR);
        setMouthOpen(Math.min(smoothedRmsRef.current / RMS_CEILING, 1));
        animationFrameRef.current = requestAnimationFrame(updateMouth);
      };

      return new Promise<void>((resolve) => {
        source.onended = () => {
          if (generation === generationRef.current) clearPlayback();
          resolve();
        };
        setIsSpeaking(true);
        animationFrameRef.current = requestAnimationFrame(updateMouth);
        source.start();
        options?.onStart?.();
      });
    },
    [clearPlayback],
  );

  useEffect(() => {
    return () => {
      stop();
      if (contextRef.current?.state !== 'closed') {
        void contextRef.current?.close();
      }
    };
  }, [stop]);

  return { isSpeaking, mouthOpen, play, prepare, stop };
}
