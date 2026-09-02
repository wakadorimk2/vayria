import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlayAudio } from '../src/audio/useAudioLipSync.js';
import { readAudioPlaybackSource } from '../src/audio/audioPlaybackSource.js';
import { pumpMediaSourceAudio } from '../src/audio/mediaSourceStream.js';
import {
  readTtsFallback,
  summarizeTtsBenchmark,
  type TtsBenchmarkSample,
} from '../src/audio/ttsBenchmark.js';
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
