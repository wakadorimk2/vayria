import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BARGE_IN_DUCK_GAIN,
  BARGE_IN_GAIN_RAMP_MS,
} from '../voice/audioLab.js';

const SMOOTHING_FACTOR = 0.5;
const RMS_CEILING = 0.12;
const REACTION_GAIN_SCALE = 0.55;

export interface PlayAudioOptions {
  startDelayMs?: number;
  onReadyToStart?: (scheduledStartAt: number) => boolean | void;
  onStart?: (startedAt: number) => void;
}

export type PlayAudio = (
  audioData: ArrayBuffer,
  options?: PlayAudioOptions,
) => Promise<void>;

export type PlayReactionAudio = (audioData: ArrayBuffer) => Promise<boolean>;

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(value, 1));
}

export function useAudioLipSync(volume = 1) {
  const normalizedVolume = clampVolume(volume);
  const [mouthOpen, setMouthOpen] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isReactionPlaying, setIsReactionPlaying] = useState(false);
  const [isAudioUnlocked, setIsAudioUnlocked] = useState(false);
  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const reactionAnalyserRef = useRef<AnalyserNode | null>(null);
  const reactionGainRef = useRef<GainNode | null>(null);
  const reactionSourceRef = useRef<AudioBufferSourceNode | null>(null);
  const startTimerRef = useRef<number | null>(null);
  const animationFrameRef = useRef(0);
  const reactionAnimationFrameRef = useRef(0);
  const smoothedRmsRef = useRef(0);
  const reactionSmoothedRmsRef = useRef(0);
  const generationRef = useRef(0);
  const reactionGenerationRef = useRef(0);
  const primaryPlaybackActiveRef = useRef(false);
  const duckedRef = useRef(false);
  const primaryMouthOpenRef = useRef(0);
  const reactionMouthOpenRef = useRef(0);
  const volumeRef = useRef(normalizedVolume);

  const ensureAudioContext = useCallback(() => {
    if (!contextRef.current || contextRef.current.state === 'closed') {
      contextRef.current = new AudioContext();
      gainRef.current = null;
      reactionGainRef.current = null;
    }

    if (!gainRef.current) {
      const gain = contextRef.current.createGain();
      gain.gain.value =
        volumeRef.current * (duckedRef.current ? BARGE_IN_DUCK_GAIN : 1);
      gain.connect(contextRef.current.destination);
      gainRef.current = gain;
    }

    if (!reactionGainRef.current) {
      const reactionGain = contextRef.current.createGain();
      reactionGain.gain.value =
        volumeRef.current *
        REACTION_GAIN_SCALE *
        (duckedRef.current ? BARGE_IN_DUCK_GAIN : 1);
      reactionGain.connect(contextRef.current.destination);
      reactionGainRef.current = reactionGain;
    }

    return contextRef.current;
  }, []);

  const prepare = useCallback(async () => {
    let context: AudioContext;
    try {
      context = ensureAudioContext();
    } catch {
      return false;
    }

    if (context.state !== 'running') {
      try {
        await context.resume();
      } catch {
        return false;
      }
    }

    const unlocked = context.state === 'running';
    if (unlocked) setIsAudioUnlocked(true);
    return unlocked;
  }, [ensureAudioContext]);

  const clearPlayback = useCallback(() => {
    if (startTimerRef.current !== null) {
      window.clearTimeout(startTimerRef.current);
      startTimerRef.current = null;
    }

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

    analyserRef.current?.disconnect();
    analyserRef.current = null;
    smoothedRmsRef.current = 0;
    primaryMouthOpenRef.current = 0;
    setMouthOpen(reactionMouthOpenRef.current);
    setIsSpeaking(false);
    primaryPlaybackActiveRef.current = false;
  }, []);

  const clearReactionPlayback = useCallback(() => {
    if (reactionSourceRef.current) {
      try {
        reactionSourceRef.current.stop();
      } catch {
        // The source already stopped.
      }
      reactionSourceRef.current.disconnect();
      reactionSourceRef.current = null;
    }

    if (reactionAnimationFrameRef.current) {
      cancelAnimationFrame(reactionAnimationFrameRef.current);
      reactionAnimationFrameRef.current = 0;
    }

    reactionAnalyserRef.current?.disconnect();
    reactionAnalyserRef.current = null;
    reactionSmoothedRmsRef.current = 0;
    reactionMouthOpenRef.current = 0;
    setMouthOpen(primaryMouthOpenRef.current);
    setIsReactionPlaying(false);
  }, []);

  const stopReaction = useCallback(() => {
    reactionGenerationRef.current += 1;
    clearReactionPlayback();
  }, [clearReactionPlayback]);

  const stop = useCallback(() => {
    generationRef.current += 1;
    clearPlayback();
    stopReaction();
  }, [clearPlayback, stopReaction]);

  const setDucked = useCallback((ducked: boolean) => {
    duckedRef.current = ducked;
    const context = contextRef.current;
    if (!context || context.state === 'closed') return;

    const targetMultiplier = ducked ? BARGE_IN_DUCK_GAIN : 1;
    const targetTime = context.currentTime + BARGE_IN_GAIN_RAMP_MS / 1_000;
    for (const [gain, baseGain] of [
      [gainRef.current, volumeRef.current],
      [reactionGainRef.current, volumeRef.current * REACTION_GAIN_SCALE],
    ] as const) {
      if (!gain) continue;
      gain.gain.cancelScheduledValues(context.currentTime);
      gain.gain.setValueAtTime(gain.gain.value, context.currentTime);
      gain.gain.linearRampToValueAtTime(
        baseGain * targetMultiplier,
        targetTime,
      );
    }
  }, []);

  const play = useCallback<PlayAudio>(
    async (audioData, options) => {
      const generation = generationRef.current + 1;
      generationRef.current = generation;
      reactionGenerationRef.current += 1;
      clearPlayback();
      clearReactionPlayback();
      primaryPlaybackActiveRef.current = true;

      try {
        const context = ensureAudioContext();
        if (context.state !== 'running') {
          await context.resume();
        }
        if (context.state !== 'running') {
          throw new Error('AudioContext is not running');
        }
        setIsAudioUnlocked(true);

        const decodedAudio = await context.decodeAudioData(audioData.slice(0));
        if (generation !== generationRef.current) return;

        const source = context.createBufferSource();
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        source.buffer = decodedAudio;
        source.connect(analyser);
        analyser.connect(gainRef.current!);
        sourceRef.current = source;
        analyserRef.current = analyser;

        const samples = new Float32Array(analyser.fftSize);
        const requestedDelayMs = options?.startDelayMs ?? 0;
        const startDelayMs = Number.isFinite(requestedDelayMs)
          ? Math.max(0, Math.min(requestedDelayMs, 10_000))
          : 0;
        const scheduledStartAt = performance.now() + startDelayMs;
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
          primaryMouthOpenRef.current = Math.min(
            smoothedRmsRef.current / RMS_CEILING,
            1,
          );
          setMouthOpen(
            Math.max(primaryMouthOpenRef.current, reactionMouthOpenRef.current),
          );
          animationFrameRef.current = requestAnimationFrame(updateMouth);
        };

        return new Promise<void>((resolve) => {
          source.onended = () => {
            if (generation === generationRef.current) clearPlayback();
            resolve();
          };

          const markStarted = () => {
            if (
              generation !== generationRef.current ||
              sourceRef.current !== source
            ) {
              return;
            }
            setIsSpeaking(true);
            animationFrameRef.current = requestAnimationFrame(updateMouth);
            options?.onStart?.(performance.now());
          };

          const readyToStart = options?.onReadyToStart?.(scheduledStartAt);
          const effectiveStartDelayMs =
            readyToStart === false ? 0 : startDelayMs;
          const scheduledAudioTime =
            context.currentTime + effectiveStartDelayMs / 1_000;
          source.start(scheduledAudioTime);
          if (effectiveStartDelayMs > 0) {
            startTimerRef.current = window.setTimeout(() => {
              startTimerRef.current = null;
              markStarted();
            }, effectiveStartDelayMs);
          } else {
            markStarted();
          }
        });
      } catch (error) {
        if (generation === generationRef.current) clearPlayback();
        throw error;
      }
    },
    [clearPlayback, clearReactionPlayback, ensureAudioContext],
  );

  const playReaction = useCallback<PlayReactionAudio>(
    async (audioData) => {
      if (primaryPlaybackActiveRef.current) return false;

      const generation = reactionGenerationRef.current + 1;
      reactionGenerationRef.current = generation;
      clearReactionPlayback();

      try {
        const context = ensureAudioContext();
        if (context.state !== 'running') {
          await context.resume();
        }
        if (
          context.state !== 'running' ||
          primaryPlaybackActiveRef.current ||
          generation !== reactionGenerationRef.current
        ) {
          return false;
        }
        setIsAudioUnlocked(true);

        const decodedAudio = await context.decodeAudioData(audioData.slice(0));
        if (
          primaryPlaybackActiveRef.current ||
          generation !== reactionGenerationRef.current
        ) {
          return false;
        }

        const source = context.createBufferSource();
        const analyser = context.createAnalyser();
        analyser.fftSize = 2048;
        source.buffer = decodedAudio;
        source.connect(analyser);
        analyser.connect(reactionGainRef.current!);
        reactionSourceRef.current = source;
        reactionAnalyserRef.current = analyser;

        const samples = new Float32Array(analyser.fftSize);
        const updateMouth = () => {
          if (
            generation !== reactionGenerationRef.current ||
            reactionAnalyserRef.current !== analyser
          ) {
            return;
          }

          analyser.getFloatTimeDomainData(samples);
          let squaredTotal = 0;
          for (const sample of samples) {
            squaredTotal += sample * sample;
          }
          const rms = Math.sqrt(squaredTotal / samples.length);
          reactionSmoothedRmsRef.current =
            reactionSmoothedRmsRef.current * SMOOTHING_FACTOR +
            rms * (1 - SMOOTHING_FACTOR);
          reactionMouthOpenRef.current = Math.min(
            reactionSmoothedRmsRef.current / RMS_CEILING,
            1,
          );
          setMouthOpen(
            Math.max(primaryMouthOpenRef.current, reactionMouthOpenRef.current),
          );
          reactionAnimationFrameRef.current = requestAnimationFrame(updateMouth);
        };

        return await new Promise<boolean>((resolve) => {
          source.onended = () => {
            const isCurrent = generation === reactionGenerationRef.current;
            if (isCurrent) clearReactionPlayback();
            resolve(isCurrent);
          };
          setIsReactionPlaying(true);
          reactionAnimationFrameRef.current = requestAnimationFrame(updateMouth);
          source.start();
        });
      } catch {
        if (generation === reactionGenerationRef.current) {
          clearReactionPlayback();
        }
        return false;
      }
    },
    [clearReactionPlayback, ensureAudioContext],
  );

  useEffect(() => {
    volumeRef.current = normalizedVolume;
    const context = contextRef.current;
    const gain = gainRef.current;
    if (context && gain && context.state !== 'closed') {
      gain.gain.setValueAtTime(
        normalizedVolume * (duckedRef.current ? BARGE_IN_DUCK_GAIN : 1),
        context.currentTime,
      );
    }
    const reactionGain = reactionGainRef.current;
    if (context && reactionGain && context.state !== 'closed') {
      reactionGain.gain.setValueAtTime(
        normalizedVolume *
          REACTION_GAIN_SCALE *
          (duckedRef.current ? BARGE_IN_DUCK_GAIN : 1),
        context.currentTime,
      );
    }
  }, [normalizedVolume]);

  useEffect(() => {
    return () => {
      stop();
      gainRef.current?.disconnect();
      gainRef.current = null;
      reactionGainRef.current?.disconnect();
      reactionGainRef.current = null;
      if (contextRef.current?.state !== 'closed') {
        void contextRef.current?.close();
      }
    };
  }, [stop]);

  return {
    isAudioUnlocked,
    isReactionPlaying,
    isSpeaking,
    mouthOpen,
    play,
    playReaction,
    prepare,
    setDucked,
    stopReaction,
    stop,
  };
}
