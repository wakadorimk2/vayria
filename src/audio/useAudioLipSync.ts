import { useCallback, useEffect, useRef, useState } from 'react';
import {
  BARGE_IN_DUCK_GAIN,
  BARGE_IN_GAIN_RAMP_MS,
} from '../voice/audioLab.js';
import type { AudioPlaybackSource } from './audioPlaybackSource.js';
import {
  createMediaSourceStreamTarget,
  pumpMediaSourceAudio,
} from './mediaSourceStream.js';
import {
  isPlaybackGestureError,
  PlaybackGestureGate,
  PersistentStreamingAudio,
} from './persistentStreamingAudio.js';

const SMOOTHING_FACTOR = 0.5;
const RMS_CEILING = 0.12;
const REACTION_GAIN_SCALE = 0.55;
const DEV_RESOURCE_CLEANUP_GRACE_MS = 100;
const isDevelopmentBuild =
  (import.meta as ImportMeta & { env?: { DEV?: boolean } }).env?.DEV === true;

export interface PlayAudioOptions {
  startDelayMs?: number;
  onComplete?: (completedAt: number) => void;
  onFirstAudioReady?: (readyAt: number) => void;
  onReadyToStart?: (scheduledStartAt: number) => boolean | void;
  onStart?: (startedAt: number) => void;
}

export type PlayAudio = (
  source: AudioPlaybackSource,
  options?: PlayAudioOptions,
) => Promise<void>;

export type PlayReactionAudio = (audioData: ArrayBuffer) => Promise<boolean>;

function clampVolume(value: number): number {
  if (!Number.isFinite(value)) return 1;
  return Math.max(0, Math.min(value, 1));
}

interface WindowWithManagedMediaSource {
  MediaSource?: typeof MediaSource;
  ManagedMediaSource?: typeof MediaSource;
}

function readStreamingMediaSourceConstructor(): typeof MediaSource | null {
  const mediaWindow = window as unknown as WindowWithManagedMediaSource;
  return mediaWindow.ManagedMediaSource ?? mediaWindow.MediaSource ?? null;
}

async function collectAudioStream(
  stream: ReadableStream<Uint8Array>,
  onFirstAudioReady?: (readyAt: number) => void,
  onComplete?: (completedAt: number) => void,
): Promise<ArrayBuffer> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let byteLength = 0;
  let first = true;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    if (!value?.byteLength) continue;
    if (first) {
      first = false;
      onFirstAudioReady?.(performance.now());
    }
    chunks.push(value);
    byteLength += value.byteLength;
  }
  onComplete?.(performance.now());
  const combined = new Uint8Array(byteLength);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return combined.buffer;
}

export function useAudioLipSync(volume = 1) {
  const normalizedVolume = clampVolume(volume);
  const [mouthOpen, setMouthOpen] = useState(0);
  const [isSpeaking, setIsSpeaking] = useState(false);
  const [isReactionPlaying, setIsReactionPlaying] = useState(false);
  const [isAudioUnlocked, setIsAudioUnlocked] = useState(false);
  const [needsPlaybackGesture, setNeedsPlaybackGesture] = useState(false);
  const contextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const gainRef = useRef<GainNode | null>(null);
  const sourceRef = useRef<AudioBufferSourceNode | null>(null);
  const persistentStreamingAudioRef = useRef<PersistentStreamingAudio | null>(null);
  const mediaSourceUrlRef = useRef<string | null>(null);
  const mediaSourceCleanupRef = useRef<(() => void) | null>(null);
  const sourceBufferRef = useRef<SourceBuffer | null>(null);
  const streamReaderRef = useRef<ReadableStreamDefaultReader<Uint8Array> | null>(null);
  const streamCancelRef = useRef<(() => void) | null>(null);
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
  const deferredCleanupTimerRef = useRef<number | null>(null);
  const playbackGestureWaitRef = useRef<{
    gate: PlaybackGestureGate;
    generation: number;
  } | null>(null);

  const ensureAudioContext = useCallback(() => {
    if (!contextRef.current || contextRef.current.state === 'closed') {
      persistentStreamingAudioRef.current?.dispose();
      persistentStreamingAudioRef.current = null;
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

  const ensurePersistentStreamingAudio = useCallback((context: AudioContext) => {
    if (!persistentStreamingAudioRef.current) {
      persistentStreamingAudioRef.current = new PersistentStreamingAudio();
    }
    return persistentStreamingAudioRef.current.ensure(context);
  }, []);

  const prepare = useCallback((): Promise<boolean> => {
    let context: AudioContext;
    try {
      context = ensureAudioContext();
      ensurePersistentStreamingAudio(context);
    } catch {
      return Promise.resolve(false);
    }

    const gestureWait = playbackGestureWaitRef.current;
    const prepareAttempt = () =>
      persistentStreamingAudioRef.current!.prepare(context, Boolean(gestureWait));
    const preparePromise = (
      gestureWait ? gestureWait.gate.resume(prepareAttempt) : prepareAttempt()
    )
      .then((ready) => {
        if (!ready) return false;
        setIsAudioUnlocked(true);
        if (
          gestureWait &&
          playbackGestureWaitRef.current === gestureWait &&
          gestureWait.generation === generationRef.current
        ) {
          playbackGestureWaitRef.current = null;
          setNeedsPlaybackGesture(false);
        }
        return true;
      });
    return preparePromise;
  }, [ensureAudioContext, ensurePersistentStreamingAudio]);

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

    streamCancelRef.current?.();
    streamCancelRef.current = null;
    const gestureWait = playbackGestureWaitRef.current;
    playbackGestureWaitRef.current = null;
    if (gestureWait) {
      gestureWait.gate.cancel(
        new DOMException('Playback aborted.', 'AbortError'),
      );
    }
    setNeedsPlaybackGesture(false);
    if (streamReaderRef.current) {
      void streamReaderRef.current.cancel().catch(() => undefined);
      streamReaderRef.current = null;
    }
    mediaSourceCleanupRef.current?.();
    mediaSourceCleanupRef.current = null;
    if (sourceBufferRef.current?.updating) {
      try {
        sourceBufferRef.current.abort();
      } catch {
        // The MediaSource is no longer open.
      }
    }
    sourceBufferRef.current = null;
    persistentStreamingAudioRef.current?.clearSource();
    persistentStreamingAudioRef.current?.disconnect();
    if (mediaSourceUrlRef.current) {
      URL.revokeObjectURL(mediaSourceUrlRef.current);
      mediaSourceUrlRef.current = null;
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
    async (requestedSource, options) => {
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

        let audioSource = requestedSource;
        const MediaSourceConstructor = readStreamingMediaSourceConstructor();
        if (
          audioSource.kind === 'stream' &&
          (!MediaSourceConstructor ||
            !MediaSourceConstructor.isTypeSupported(audioSource.mimeType))
        ) {
          audioSource = {
            kind: 'buffer',
            mimeType: audioSource.mimeType,
            data: await collectAudioStream(
              audioSource.stream,
              options?.onFirstAudioReady,
              options?.onComplete,
            ),
          };
        }

        if (audioSource.kind === 'stream' && MediaSourceConstructor) {
          const mediaSource = new MediaSourceConstructor();
          const { source: elementSource } =
            ensurePersistentStreamingAudio(context);
          const mediaUrl = URL.createObjectURL(mediaSource);
          const audio = persistentStreamingAudioRef.current!.setSource(mediaUrl);
          mediaSourceUrlRef.current = mediaUrl;

          const analyser = context.createAnalyser();
          analyser.fftSize = 2048;
          elementSource.connect(analyser);
          analyser.connect(gainRef.current!);
          analyserRef.current = analyser;

          await new Promise<void>((resolve, reject) => {
            const handleSourceOpen = () => {
              cleanup();
              resolve();
            };
            const handleSourceError = () => {
              cleanup();
              reject(new Error('Streaming media source failed.'));
            };
            const cleanup = () => {
              mediaSource.removeEventListener('sourceopen', handleSourceOpen);
              mediaSource.removeEventListener('error', handleSourceError);
              if (mediaSourceCleanupRef.current === cleanup) {
                mediaSourceCleanupRef.current = null;
              }
            };
            mediaSourceCleanupRef.current = cleanup;
            mediaSource.addEventListener('sourceopen', handleSourceOpen, { once: true });
            mediaSource.addEventListener('error', handleSourceError, { once: true });
          });
          if (generation !== generationRef.current) return;

          const sourceBuffer = mediaSource.addSourceBuffer(audioSource.mimeType);
          sourceBufferRef.current = sourceBuffer;
          const reader = audioSource.stream.getReader();
          streamReaderRef.current = reader;
          let resolveFirstAudio: () => void = () => undefined;
          let rejectPlayback: (error: unknown) => void = () => undefined;
          const firstAudio = new Promise<void>((resolve) => {
            resolveFirstAudio = resolve;
          });
          const interrupted = new Promise<never>((_resolve, reject) => {
            rejectPlayback = reject;
          });
          streamCancelRef.current = () =>
            rejectPlayback(new DOMException('Playback aborted.', 'AbortError'));

          const pump = pumpMediaSourceAudio(
            reader,
            createMediaSourceStreamTarget(mediaSource, sourceBuffer),
            {
              onFirstChunk: () => {
                options?.onFirstAudioReady?.(performance.now());
                resolveFirstAudio();
              },
              onComplete: () => options?.onComplete?.(performance.now()),
            },
          );
          void pump.catch(() => undefined);

          await Promise.race([firstAudio, interrupted, pump]);
          if (generation !== generationRef.current) return;

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
            for (const sample of samples) squaredTotal += sample * sample;
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

          const requestedDelayMs = options?.startDelayMs ?? 0;
          const startDelayMs = Number.isFinite(requestedDelayMs)
            ? Math.max(0, Math.min(requestedDelayMs, 10_000))
            : 0;
          const scheduledStartAt = performance.now() + startDelayMs;
          const readyToStart = options?.onReadyToStart?.(scheduledStartAt);
          const effectiveStartDelayMs = readyToStart === false ? 0 : startDelayMs;
          const handlePlaying = () => {
            setIsSpeaking(true);
            animationFrameRef.current = requestAnimationFrame(updateMouth);
            options?.onStart?.(performance.now());
          };
          const ended = new Promise<void>((resolve, reject) => {
            const handleEnded = () => {
              cleanup();
              resolve();
            };
            const handleError = () => {
              cleanup();
              reject(new Error('Streaming audio playback failed.'));
            };
            const cleanup = () => {
              audio.removeEventListener('playing', handlePlaying);
              audio.removeEventListener('ended', handleEnded);
              audio.removeEventListener('error', handleError);
              if (mediaSourceCleanupRef.current === cleanup) {
                mediaSourceCleanupRef.current = null;
              }
            };
            mediaSourceCleanupRef.current = cleanup;
            audio.addEventListener('playing', handlePlaying, { once: true });
            audio.addEventListener('ended', handleEnded, { once: true });
            audio.addEventListener('error', handleError, { once: true });
          });
          void ended.catch(() => undefined);
          if (effectiveStartDelayMs > 0) {
            await Promise.race([
              new Promise<void>((resolve) => {
                startTimerRef.current = window.setTimeout(() => {
                  startTimerRef.current = null;
                  resolve();
                }, effectiveStartDelayMs);
              }),
              interrupted,
            ]);
          }
          try {
            await audio.play();
          } catch (error) {
            if (!isPlaybackGestureError(error)) throw error;
            if (generation !== generationRef.current) return;
            const gate = new PlaybackGestureGate();
            playbackGestureWaitRef.current = { gate, generation };
            setNeedsPlaybackGesture(true);
            await gate.wait();
          }
          await Promise.race([Promise.all([pump, ended]), interrupted]);
          if (generation === generationRef.current) clearPlayback();
          return;
        }

        if (audioSource.kind !== 'buffer') {
          throw new Error('Streaming audio is not supported in this browser.');
        }
        const decodedAudio = await context.decodeAudioData(audioSource.data.slice(0));
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
        if (generation !== generationRef.current) return;
        throw error;
      }
    },
    [
      clearPlayback,
      clearReactionPlayback,
      ensureAudioContext,
      ensurePersistentStreamingAudio,
    ],
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
    if (deferredCleanupTimerRef.current !== null) {
      window.clearTimeout(deferredCleanupTimerRef.current);
      deferredCleanupTimerRef.current = null;
    }

    const disposeAudioResources = () => {
      deferredCleanupTimerRef.current = null;
      stop();
      gainRef.current?.disconnect();
      gainRef.current = null;
      reactionGainRef.current?.disconnect();
      reactionGainRef.current = null;
      persistentStreamingAudioRef.current?.dispose();
      persistentStreamingAudioRef.current = null;
      if (contextRef.current?.state !== 'closed') {
        void contextRef.current?.close();
      }
    };

    return () => {
      if (isDevelopmentBuild) {
        deferredCleanupTimerRef.current = window.setTimeout(
          disposeAudioResources,
          DEV_RESOURCE_CLEANUP_GRACE_MS,
        );
        return;
      }

      disposeAudioResources();
    };
  }, [stop]);

  return {
    isAudioUnlocked,
    isReactionPlaying,
    isSpeaking,
    mouthOpen,
    needsPlaybackGesture,
    play,
    playReaction,
    prepare,
    setDucked,
    stopReaction,
    stop,
  };
}
