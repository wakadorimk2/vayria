import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlayAudio } from '../src/audio/useAudioLipSync.js';
import { readAudioPlaybackSource } from '../src/audio/audioPlaybackSource.js';
import { pumpMediaSourceAudio } from '../src/audio/mediaSourceStream.js';
import {
  createSilentWavBytes,
  isPlaybackGestureError,
  monitorPlaybackStart,
  PlaybackGestureGate,
  PersistentStreamingAudio,
} from '../src/audio/persistentStreamingAudio.js';
import {
  readTtsFallback,
  summarizeTtsBenchmark,
  type TtsBenchmarkSample,
} from '../src/audio/ttsBenchmark.js';
import {
  calculatePlaybackDiagnosticDurations,
  ConsecutiveRmsTracker,
  summarizePlaybackDiagnostics,
  type TtsPlaybackDiagnosticSample,
} from '../src/audio/ttsPlaybackDiagnostics.js';
import {
  PerformancePlaybackCoordinator,
  type PerformanceMotionPort,
  type PerformancePlaybackClock,
  type PerformancePlaybackTimerHandle,
} from '../src/performer/performancePlayback.js';

function bufferSource() {
  return {
    kind: 'buffer' as const,
    data: new ArrayBuffer(0),
    mimeType: 'audio/wav',
  };
}

class FakeStreamingAudioElement {
  currentTime = 0;
  disableRemotePlayback = false;
  preload = '';
  src = '';
  playCalls = 0;
  playImplementation: () => Promise<void> = () => Promise.resolve();
  readonly events: string[];

  constructor(events: string[]) {
    this.events = events;
  }

  load(): void {
    this.events.push('load');
  }

  pause(): void {
    this.events.push('pause');
  }

  play(): Promise<void> {
    this.playCalls += 1;
    this.events.push('play');
    return this.playImplementation();
  }

  removeAttribute(name: string): void {
    if (name === 'src') this.src = '';
  }
}

test('silent unlock WAV has a valid 100 ms PCM structure', () => {
  const bytes = createSilentWavBytes();
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.slice(offset, offset + length));

  assert.equal(ascii(0, 4), 'RIFF');
  assert.equal(ascii(8, 4), 'WAVE');
  assert.equal(ascii(12, 4), 'fmt ');
  assert.equal(ascii(36, 4), 'data');
  assert.equal(view.getUint32(4, true) + 8, bytes.byteLength);
  assert.equal(view.getUint16(20, true), 1);
  assert.equal(view.getUint16(22, true), 1);
  assert.equal(view.getUint32(24, true), 8_000);
  assert.equal(view.getUint16(34, true), 16);
  assert.equal(view.getUint32(40, true), 1_600);
  assert.equal(bytes.byteLength, 1_644);
});

test('RMS diagnostics require three consecutive active frames', () => {
  const tracker = new ConsecutiveRmsTracker();
  const silence = new Float32Array([0, 0]);
  const active = new Float32Array([0.001, -0.001]);

  tracker.sample(active, 10);
  tracker.sample(active, 20);
  tracker.sample(silence, 30);
  tracker.sample(active, 40);
  tracker.sample(active, 50);
  assert.equal(tracker.result().firstNonzeroAt, null);
  tracker.sample(active, 60);

  const result = tracker.result();
  assert.equal(result.activeFrames, 5);
  assert.equal(result.firstNonzeroAt, 60);
  assert.ok(Math.abs(result.max - 0.001) < 0.000001);
  assert.equal(result.totalFrames, 6);
});

test('playback diagnostics calculate nullable durations and summaries', () => {
  const timestamps = {
    current_time_advanced_at: 150,
    decode_complete_at: 130,
    ended_at: 1_000,
    first_chunk_at: 20,
    first_nonzero_rms_at: 180,
    play_called_at: 100,
    playing_at: 120,
    request_at: 0,
    response_complete_at: 90,
    response_headers_at: 10,
  };
  const durationsMs = calculatePlaybackDiagnosticDurations(timestamps);
  assert.deepEqual(durationsMs, {
    decode: 40,
    download: 90,
    firstChunk: 20,
    playToPlaying: 20,
    playingToCurrentTime: 30,
    playingToFirstRms: 60,
    total: 1_000,
  });

  const createSample = (
    strategy: TtsPlaybackDiagnosticSample['strategy'],
    rmsDelay: number | null,
  ): TtsPlaybackDiagnosticSample => ({
    backend: 'aivis-cloud',
    durationsMs: { ...durationsMs, playingToFirstRms: rmsDelay },
    fixtureId: 'short',
    iteration: 1,
    mediaType: 'audio/mpeg',
    rms: {
      activeFrames: rmsDelay === null ? 0 : 4,
      firstNonzeroDetected: rmsDelay !== null,
      max: rmsDelay === null ? 0 : 0.01,
      totalFrames: 10,
    },
    strategy,
    textLength: 8,
    timestamps,
  });
  const summaries = summarizePlaybackDiagnostics([
    createSample('media-source', null),
    createSample('media-source', 30),
    createSample('media-source', 10),
  ]);
  assert.deepEqual(summaries[0], {
    fixtureId: 'short',
    firstRmsCount: 2,
    firstRmsDelayMs: { max: 30, median: 20 },
    sampleCount: 3,
    strategy: 'media-source',
  });
  assert.equal(summaries.length, 9);
});

test('playback start monitor handles success, rejection, and pending playback', async () => {
  assert.equal(
    await monitorPlaybackStart(Promise.resolve(), new Promise(() => undefined), 20),
    'started',
  );
  assert.equal(
    await monitorPlaybackStart(
      Promise.reject({ name: 'NotAllowedError' }),
      new Promise(() => undefined),
      20,
    ),
    'not_allowed',
  );
  assert.equal(
    await monitorPlaybackStart(
      new Promise(() => undefined),
      new Promise(() => undefined),
      5,
    ),
    'start_timeout',
  );
  await assert.rejects(
    monitorPlaybackStart(
      Promise.reject(new Error('decoder failed')),
      new Promise(() => undefined),
      20,
    ),
    /decoder failed/,
  );
});

test('pending unlock returns false at its deadline and keeps no silent source', async () => {
  const events: string[] = [];
  const audio = new FakeStreamingAudioElement(events);
  audio.playImplementation = () => new Promise(() => undefined);
  const context = {
    createMediaElementSource: () => ({ disconnect: () => undefined }),
    state: 'running',
  } as unknown as AudioContext;
  const carrier = new PersistentStreamingAudio(
    () => audio as unknown as HTMLAudioElement,
  );

  assert.equal(await carrier.prepare(context, false, 5), false);
  assert.equal(audio.src, '');
});

test('persistent streaming audio reuses one element and one source node', () => {
  const events: string[] = [];
  let elementCount = 0;
  let sourceCount = 0;
  const audio = new FakeStreamingAudioElement(events);
  const source = { disconnect: () => events.push('disconnect') };
  const context = {
    createMediaElementSource: (element: HTMLMediaElement) => {
      assert.equal(element, audio as unknown as HTMLAudioElement);
      sourceCount += 1;
      return source;
    },
    state: 'running',
  } as unknown as AudioContext;
  const carrier = new PersistentStreamingAudio(() => {
    elementCount += 1;
    return audio as unknown as HTMLAudioElement;
  });

  const first = carrier.ensure(context);
  carrier.setSource('blob:first');
  carrier.disconnect();
  const second = carrier.ensure(context);

  assert.equal(first.audio, second.audio);
  assert.equal(first.source, second.source);
  assert.equal(elementCount, 1);
  assert.equal(sourceCount, 1);
});

test('audio context and persistent element unlock start synchronously', async () => {
  const events: string[] = [];
  const audio = new FakeStreamingAudioElement(events);
  const context = {
    createMediaElementSource: () => ({ disconnect: () => undefined }),
    resume: () => {
      events.push('resume');
      return Promise.resolve();
    },
    state: 'suspended',
  } as unknown as AudioContext;
  const carrier = new PersistentStreamingAudio(
    () => audio as unknown as HTMLAudioElement,
  );

  const preparation = carrier.prepare(context, false);
  assert.deepEqual(
    events.filter((event) => event === 'resume' || event === 'play'),
    ['resume', 'play'],
  );
  await preparation;
});

test('gesture recovery resumes the same streaming element and source', async () => {
  const events: string[] = [];
  const audio = new FakeStreamingAudioElement(events);
  const context = {
    createMediaElementSource: () => ({ disconnect: () => undefined }),
    state: 'running',
  } as unknown as AudioContext;
  const carrier = new PersistentStreamingAudio(
    () => audio as unknown as HTMLAudioElement,
  );
  carrier.ensure(context);
  carrier.setSource('blob:held-stream');

  await carrier.prepare(context, true);

  assert.equal(audio.src, 'blob:held-stream');
  assert.equal(audio.playCalls, 1);
  assert.equal(carrier.ensure(context).audio, audio as unknown as HTMLAudioElement);
});

test('normal cleanup retains the carrier and unmount disposal releases it', () => {
  const events: string[] = [];
  let elementCount = 0;
  const context = {
    createMediaElementSource: () => ({ disconnect: () => events.push('disconnect') }),
    state: 'running',
  } as unknown as AudioContext;
  const carrier = new PersistentStreamingAudio(() => {
    elementCount += 1;
    return new FakeStreamingAudioElement(events) as unknown as HTMLAudioElement;
  });

  const original = carrier.ensure(context).audio;
  carrier.setSource('blob:active-stream');
  carrier.clearSource();
  assert.equal(carrier.ensure(context).audio, original);
  assert.equal(elementCount, 1);

  carrier.dispose();
  assert.notEqual(carrier.ensure(context).audio, original);
  assert.equal(elementCount, 2);
});

test('playback gesture errors are classified without exposing message text', () => {
  assert.equal(
    isPlaybackGestureError({
      message: 'platform-specific private detail',
      name: 'NotAllowedError',
    }),
    true,
  );
  assert.equal(isPlaybackGestureError(new Error('NotAllowedError')), false);
});

test('playback gesture gate resumes once and cancels pending playback', async () => {
  const gate = new PlaybackGestureGate();
  const waiting = gate.wait();
  let attempts = 0;
  const firstResume = gate.resume(async () => {
    attempts += 1;
    return true;
  });
  const duplicateResume = gate.resume(async () => {
    attempts += 1;
    return true;
  });

  assert.equal(await firstResume, true);
  assert.equal(await duplicateResume, true);
  await waiting;
  assert.equal(attempts, 1);
  assert.equal(gate.isWaiting, false);

  const cancelledGate = new PlaybackGestureGate();
  const cancelled = cancelledGate.wait();
  cancelledGate.cancel(new DOMException('Playback aborted.', 'AbortError'));
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal(cancelledGate.isWaiting, false);
});

test('a late playing event completes an in-flight gesture resume', async () => {
  const gate = new PlaybackGestureGate();
  const waiting = gate.wait();
  let resolveAttempt: ((ready: boolean) => void) | undefined;
  const resume = gate.resume(
    () =>
      new Promise<boolean>((resolve) => {
        resolveAttempt = resolve;
      }),
  );

  gate.complete();
  await waiting;
  resolveAttempt?.(true);
  assert.equal(await resume, true);
});
import type { PerformancePlan } from '../src/performer/types.js';

class FakeClock implements PerformancePlaybackClock {
  private currentTime = 1_000;
  private nextTimerId = 1;
  private readonly timers = new Map<
    number,
    { callback: () => void; dueAt: number }
  >();

  now(): number {
    return this.currentTime;
  }

  setTimeout(
    callback: () => void,
    delayMs: number,
  ): PerformancePlaybackTimerHandle {
    const timerId = this.nextTimerId++;
    this.timers.set(timerId, {
      callback,
      dueAt: this.currentTime + Math.max(0, delayMs),
    });
    return timerId as unknown as PerformancePlaybackTimerHandle;
  }

  clearTimeout(handle: PerformancePlaybackTimerHandle): void {
    this.timers.delete(handle as unknown as number);
  }

  advance(delayMs: number): void {
    const targetTime = this.currentTime + Math.max(0, delayMs);
    while (true) {
      const nextTimer = [...this.timers.entries()]
        .filter(([, timer]) => timer.dueAt <= targetTime)
        .sort(([, first], [, second]) => first.dueAt - second.dueAt)[0];
      if (!nextTimer) break;

      const [timerId, timer] = nextTimer;
      this.timers.delete(timerId);
      this.currentTime = timer.dueAt;
      timer.callback();
    }
    this.currentTime = targetTime;
  }
}

function createTraceMotionPort(
  events: string[],
  prepared = true,
): PerformanceMotionPort {
  return {
    prepareMotion: async () => {
      events.push('prepare');
      return prepared;
    },
    startPreparedMotion: () => {
      events.push('motion_start');
      return 1_000;
    },
    markSpeechStart: () => events.push('speech_start_port'),
    markSpeechEnd: () => events.push('speech_end_port'),
    finishMotion: () => events.push('motion_finish'),
    stopMotion: () => events.push('motion_stop'),
  };
}

async function flushPlaybackMicrotasks(): Promise<void> {
  for (let index = 0; index < 10; index += 1) {
    await Promise.resolve();
  }
}

function createPlan(
  overrides: Partial<PerformancePlan> = {},
): PerformancePlan {
  return {
    planId: 'plan-1',
    trigger: 'viewer_message',
    intent: 'speak',
    activeDirectionIds: [],
    timing: {
      motionLeadMs: 180,
      motionEnterBlendMs: 180,
      motionExitBlendMs: 400,
      motionPreparationTimeoutMs: 100,
      postSpeechHoldMs: 0,
    },
    motion: { assetId: 'gesture' },
    ...overrides,
  };
}

test('motion starts before audio and finishes after the speech hold', async () => {
  const events: string[] = [];
  const clock = new FakeClock();
  const plan = createPlan({
    timing: {
      motionLeadMs: 180,
      motionEnterBlendMs: 180,
      motionExitBlendMs: 400,
      motionPreparationTimeoutMs: 100,
      postSpeechHoldMs: 5,
    },
  });
  const motionPort = createTraceMotionPort(events);
  let requestedDelayMs: number | undefined;
  const playAudio: PlayAudio = async (_audioData, options) => {
    requestedDelayMs = options?.startDelayMs;
    options?.onReadyToStart?.(1_180);
    options?.onStart?.(1_180);
    events.push('audio_start');
    events.push('audio_end');
  };
  const coordinator = new PerformancePlaybackCoordinator({
    getMotionPort: () => motionPort,
    playAudio,
    stopAudio: () => events.push('audio_stop'),
    clock,
  });

  coordinator.prepare(plan);
  const result = await coordinator.play(plan, bufferSource(), {
    onMotionReady: () => events.push('motion_ready'),
    onMotionStart: () => events.push('motion_started_callback'),
    onSpeechStart: () => events.push('speech_started_callback'),
    onSpeechEnd: () => {
      events.push('speech_ended_callback');
      queueMicrotask(() => clock.advance(5));
    },
  });
  await flushPlaybackMicrotasks();
  const settledResult = await result;

  assert.equal(requestedDelayMs, 180);
  assert.deepEqual(events, [
    'prepare',
    'motion_ready',
    'motion_start',
    'motion_started_callback',
    'speech_start_port',
    'speech_started_callback',
    'audio_start',
    'audio_end',
    'speech_end_port',
    'speech_ended_callback',
    'motion_finish',
  ]);
  assert.deepEqual(settledResult, {
    motionStartedAt: 1_000,
    speechStartedAt: 1_180,
    speechEndedAt: 1_000,
  });

  coordinator.stop();
  assert.equal(events.includes('motion_stop'), false);
});

test('motion preparation timeout falls back to immediate audio', async () => {
  const events: string[] = [];
  const plan = createPlan({
    timing: {
      motionLeadMs: 180,
      motionEnterBlendMs: 180,
      motionExitBlendMs: 400,
      motionPreparationTimeoutMs: 5,
      postSpeechHoldMs: 0,
    },
  });
  const motionPort: PerformanceMotionPort = {
    prepareMotion: () => new Promise<boolean>(() => undefined),
    startPreparedMotion: () => {
      events.push('motion_start');
      return 1_000;
    },
    markSpeechStart: () => undefined,
    markSpeechEnd: () => undefined,
    finishMotion: () => events.push('motion_finish'),
    stopMotion: () => events.push('motion_stop'),
  };
  let requestedDelayMs: number | undefined;
  const playAudio: PlayAudio = async (_audioData, options) => {
    requestedDelayMs = options?.startDelayMs;
    options?.onStart?.(1_000);
    events.push('audio_start');
  };
  const coordinator = new PerformancePlaybackCoordinator({
    getMotionPort: () => motionPort,
    playAudio,
    stopAudio: () => events.push('audio_stop'),
    now: () => 1_100,
  });

  coordinator.prepare(plan);
  const result = await coordinator.play(plan, bufferSource());

  assert.equal(requestedDelayMs, 0);
  assert.deepEqual(events, ['audio_start', 'motion_finish']);
  assert.deepEqual(result, {
    speechStartedAt: 1_000,
    speechEndedAt: 1_100,
  });
});

test('card reaction uses the longer expression hold as the single tail', async () => {
  const events: string[] = [];
  const clock = new FakeClock();
  const plan = createPlan({
    planId: 'card-preview-plan',
    trigger: 'external_stimulus',
    timing: {
      motionLeadMs: 0,
      motionEnterBlendMs: 180,
      motionExitBlendMs: 400,
      motionPreparationTimeoutMs: 100,
      postSpeechHoldMs: 20,
    },
    avatarProfile: {
      expressionHoldMs: 50,
      gazeDirectness: 0.8,
      idleMotionWeight: 1,
      headYawBias: 0,
    },
  });
  const motionPort = createTraceMotionPort(events);
  const playAudio: PlayAudio = async (_audioData, options) => {
    options?.onReadyToStart?.(clock.now());
    options?.onStart?.(clock.now());
    events.push('audio_start');
    events.push('audio_end');
  };
  const coordinator = new PerformancePlaybackCoordinator({
    getMotionPort: () => motionPort,
    playAudio,
    stopAudio: () => events.push('audio_stop'),
    clock,
  });

  coordinator.prepare(plan);
  const playback = coordinator.play(plan, bufferSource(), {
    onSpeechEnd: () => queueMicrotask(() => clock.advance(49)),
  });
  await flushPlaybackMicrotasks();

  assert.equal(events.includes('motion_finish'), false);
  clock.advance(1);
  const result = await playback;

  assert.deepEqual(result, {
    motionStartedAt: 1_000,
    speechStartedAt: 1_000,
    speechEndedAt: 1_000,
  });
  assert.equal(events.at(-1), 'motion_finish');
});

test('speech tail keeps the longer post-speech hold when it exceeds expression hold', async () => {
  const events: string[] = [];
  const clock = new FakeClock();
  const plan = createPlan({
    planId: 'post-speech-tail-plan',
    trigger: 'viewer_message',
    timing: {
      motionLeadMs: 0,
      motionEnterBlendMs: 180,
      motionExitBlendMs: 400,
      motionPreparationTimeoutMs: 100,
      postSpeechHoldMs: 50,
    },
    avatarProfile: {
      expressionHoldMs: 20,
      gazeDirectness: 0.8,
      idleMotionWeight: 1,
      headYawBias: 0,
    },
  });
  const motionPort = createTraceMotionPort(events);
  const playAudio: PlayAudio = async (_audioData, options) => {
    options?.onReadyToStart?.(clock.now());
    options?.onStart?.(clock.now());
    events.push('audio_start');
    events.push('audio_end');
  };
  const coordinator = new PerformancePlaybackCoordinator({
    getMotionPort: () => motionPort,
    playAudio,
    stopAudio: () => events.push('audio_stop'),
    clock,
  });

  coordinator.prepare(plan);
  const playback = coordinator.play(plan, bufferSource());
  await flushPlaybackMicrotasks();

  clock.advance(49);
  assert.equal(events.includes('motion_finish'), false);
  clock.advance(1);

  const result = await playback;
  assert.deepEqual(result, {
    motionStartedAt: 1_000,
    speechStartedAt: 1_000,
    speechEndedAt: 1_000,
  });
  assert.equal(events.at(-1), 'motion_finish');
});

test('listening fixture keeps gaze and motion connected without speech events', () => {
  const events: string[] = ['gaze_start'];
  const clock = new FakeClock();
  const motionPort = createTraceMotionPort(events);
  const planId = 'voice-reaction-1';

  motionPort.startPreparedMotion(planId);
  clock.setTimeout(() => {
    events.push('reaction_end');
    motionPort.finishMotion(planId);
    clock.setTimeout(() => events.push('idle_resume'), 400);
  }, 3_000);

  clock.advance(2_999);
  assert.equal(events.includes('reaction_end'), false);
  clock.advance(1);
  assert.equal(events.includes('motion_finish'), true);
  assert.equal(events.includes('idle_resume'), false);
  clock.advance(399);
  assert.equal(events.includes('idle_resume'), false);
  clock.advance(1);

  assert.deepEqual(events, [
    'gaze_start',
    'motion_start',
    'reaction_end',
    'motion_finish',
    'idle_resume',
  ]);
  assert.equal(events.includes('speech_start_port'), false);
  assert.equal(events.includes('speech_end_port'), false);
});

test('cancellation stops waiting playback and ignores stale motion', async () => {
  const events: string[] = [];
  const plan = createPlan({
    timing: {
      motionLeadMs: 180,
      motionEnterBlendMs: 180,
      motionExitBlendMs: 400,
      motionPreparationTimeoutMs: 1_000,
      postSpeechHoldMs: 0,
    },
  });
  const motionPort: PerformanceMotionPort = {
    prepareMotion: () => new Promise<boolean>(() => undefined),
    startPreparedMotion: () => {
      events.push('motion_start');
      return 1_000;
    },
    markSpeechStart: () => undefined,
    markSpeechEnd: () => undefined,
    finishMotion: () => events.push('motion_finish'),
    stopMotion: () => events.push('motion_stop'),
  };
  const coordinator = new PerformancePlaybackCoordinator({
    getMotionPort: () => motionPort,
    playAudio: async () => {
      events.push('audio_start');
    },
    stopAudio: () => events.push('audio_stop'),
  });

  coordinator.prepare(plan);
  const playback = coordinator.play(plan, bufferSource());
  coordinator.stop();

  assert.equal(await playback, null);
  assert.deepEqual(events, ['audio_stop', 'motion_stop']);
});

test('cancellation before audio completion suppresses stale speech end and finish', async () => {
  const events: string[] = [];
  const clock = new FakeClock();
  const plan = createPlan({
    timing: {
      motionLeadMs: 0,
      motionEnterBlendMs: 0,
      motionExitBlendMs: 400,
      motionPreparationTimeoutMs: 100,
      postSpeechHoldMs: 100,
    },
  });
  const motionPort = createTraceMotionPort(events);
  let resolveAudio: (() => void) | undefined;
  const coordinator = new PerformancePlaybackCoordinator({
    getMotionPort: () => motionPort,
    playAudio: async (_audioData, options) => {
      options?.onReadyToStart?.(clock.now());
      options?.onStart?.(clock.now());
      events.push('audio_start');
      await new Promise<void>((resolve) => {
        resolveAudio = resolve;
      });
      events.push('audio_end');
    },
    stopAudio: () => events.push('audio_stop'),
    clock,
  });

  coordinator.prepare(plan);
  const playback = coordinator.play(plan, bufferSource(), {
    onSpeechEnd: () => events.push('speech_end_callback'),
  });
  await flushPlaybackMicrotasks();
  if (!resolveAudio) throw new Error('Audio fixture did not start.');

  coordinator.stop();
  resolveAudio();
  await flushPlaybackMicrotasks();

  assert.equal(await playback, null);
  assert.equal(events.includes('speech_end_port'), false);
  assert.equal(events.includes('speech_end_callback'), false);
  assert.equal(events.includes('motion_finish'), false);
});

test('playback coordinator forwards a safe gesture requirement reason', async () => {
  let receivedReason: string | undefined;
  const coordinator = new PerformancePlaybackCoordinator({
    getMotionPort: () => null,
    playAudio: async (_audioData, options) => {
      options?.onPlaybackGestureRequired?.('start_timeout');
      options?.onStart?.(1_000);
    },
    stopAudio: () => undefined,
    now: () => 1_000,
  });

  await coordinator.play(createPlan({ motion: undefined }), bufferSource(), {
    onPlaybackGestureRequired: (reason) => {
      receivedReason = reason;
    },
  });

  assert.equal(receivedReason, 'start_timeout');
});

test('audio response keeps MP3 as a stream and buffers WAV', async () => {
  const mp3 = await readAudioPlaybackSource(
    new Response(new Uint8Array([1, 2, 3]), {
      headers: { 'Content-Type': 'audio/mpeg' },
    }),
  );
  assert.equal(mp3.kind, 'stream');

  const wav = await readAudioPlaybackSource(
    new Response(new Uint8Array([4, 5]), {
      headers: { 'Content-Type': 'audio/wav' },
    }),
  );
  assert.equal(wav.kind, 'buffer');
  if (wav.kind === 'buffer') assert.deepEqual([...new Uint8Array(wav.data)], [4, 5]);
});

test('media source pump preserves chunk order and reports stream boundaries', async () => {
  const chunks: number[][] = [];
  const events: string[] = [];
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1, 2]));
      controller.enqueue(new Uint8Array([3]));
      controller.close();
    },
  });

  await pumpMediaSourceAudio(stream.getReader(), {
    addChunk: (chunk) => chunks.push([...chunk]),
    end: () => events.push('end'),
    isUpdating: () => false,
    waitForUpdate: async () => undefined,
  }, {
    onFirstChunk: () => events.push('first'),
    onComplete: () => events.push('complete'),
  });

  assert.deepEqual(chunks, [[1, 2], [3]]);
  assert.deepEqual(events, ['first', 'end', 'complete']);
});

test('media source pump rejects an empty or interrupted stream safely', async () => {
  const target = {
    addChunk: () => undefined,
    end: () => undefined,
    isUpdating: () => false,
    waitForUpdate: async () => undefined,
  };
  const empty = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.close();
    },
  });
  await assert.rejects(
    pumpMediaSourceAudio(empty.getReader(), target),
    /response was empty/,
  );

  const interrupted = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.error(new Error('fixture network detail'));
    },
  });
  await assert.rejects(pumpMediaSourceAudio(interrupted.getReader(), target));
});

test('TTS benchmark summaries use nearest-rank p50 and p95', () => {
  const samples: TtsBenchmarkSample[] = Array.from({ length: 10 }, (_, index) => ({
    backend: 'local',
    ...(index === 0
      ? {
          fallback: {
            from: 'aivis-cloud' as const,
            reason: 'first_audio_timeout' as const,
          },
        }
      : {}),
    fixtureId: 'short',
    iteration: index + 1,
    textLength: 8,
    timestamps: {
      text_ready_at: 0,
      tts_request_at: 0,
      first_audio_at: 0,
      playback_started_at: 0,
      tts_completed_at: 0,
    },
    durationsMs: {
      firstAudio: index + 1,
      synthesis: (index + 1) * 10,
      ttfa: (index + 1) * 100,
    },
  }));
  const summary = summarizeTtsBenchmark(samples)[0];
  assert.equal(summary.sampleCount, 10);
  assert.equal(summary.fallbackCount, 1);
  assert.deepEqual(summary.firstAudioMs, { p50: 5, p95: 10 });
  assert.deepEqual(summary.synthesisMs, { p50: 50, p95: 100 });
  assert.deepEqual(summary.ttfaMs, { p50: 500, p95: 1_000 });
});

test('TTS benchmark keeps only safe fallback metadata', () => {
  const valid = readTtsFallback(
    new Headers({
      'X-Vayria-Tts-Fallback-From': 'aivis-cloud',
      'X-Vayria-Tts-Fallback-Reason': 'first_audio_timeout',
    }),
  );
  assert.deepEqual(valid, {
    from: 'aivis-cloud',
    reason: 'first_audio_timeout',
  });
  assert.equal(
    readTtsFallback(
      new Headers({
        'X-Vayria-Tts-Fallback-From': 'aivis-cloud',
        'X-Vayria-Tts-Fallback-Reason': 'secret upstream response',
      }),
    ),
    undefined,
  );
});

test('voice pending plans reprepare motion when the same turn takes the floor', () => {
  const preparedAssets: Array<string | undefined> = [];
  const motionPort: PerformanceMotionPort = {
    prepareMotion: async (plan) => {
      preparedAssets.push(plan.motion?.assetId);
      return true;
    },
    startPreparedMotion: () => 1_000,
    markSpeechStart: () => undefined,
    markSpeechEnd: () => undefined,
    finishMotion: () => undefined,
    stopMotion: () => undefined,
  };
  const coordinator = new PerformancePlaybackCoordinator({
    getMotionPort: () => motionPort,
    playAudio: async () => undefined,
    stopAudio: () => undefined,
  });
  const pendingPlan = createPlan({
    intent: 'react_nonverbally',
    motion: undefined,
  });
  const speakingPlan = createPlan();

  coordinator.prepare(pendingPlan);
  coordinator.prepare(speakingPlan);

  assert.deepEqual(preparedAssets, [undefined, 'gesture']);
  coordinator.stop();
});
