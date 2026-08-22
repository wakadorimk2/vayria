import assert from 'node:assert/strict';
import test from 'node:test';
import type { PlayAudio } from '../src/audio/useAudioLipSync.js';
import {
  PerformancePlaybackCoordinator,
  type PerformanceMotionPort,
} from '../src/performer/performancePlayback.js';
import type { PerformancePlan } from '../src/performer/types.js';

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
  const plan = createPlan({
    timing: {
      motionLeadMs: 180,
      motionEnterBlendMs: 180,
      motionExitBlendMs: 400,
      motionPreparationTimeoutMs: 100,
      postSpeechHoldMs: 5,
    },
  });
  const motionPort: PerformanceMotionPort = {
    prepareMotion: async () => {
      events.push('prepare');
      return true;
    },
    startPreparedMotion: () => {
      events.push('motion_start');
      return 1_000;
    },
    finishMotion: () => {
      events.push('motion_finish');
      events.push('idle_resume');
    },
    stopMotion: () => events.push('motion_stop'),
  };
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
    now: () => 1_200,
  });

  coordinator.prepare(plan);
  const result = await coordinator.play(plan, new ArrayBuffer(0), {
    onMotionReady: () => events.push('motion_ready'),
    onMotionStart: () => events.push('motion_started_callback'),
    onSpeechStart: () => events.push('speech_started_callback'),
  });

  assert.equal(requestedDelayMs, 180);
  assert.deepEqual(events, [
    'prepare',
    'motion_ready',
    'motion_start',
    'motion_started_callback',
    'speech_started_callback',
    'audio_start',
    'audio_end',
    'motion_finish',
    'idle_resume',
  ]);
  assert.deepEqual(result, {
    motionStartedAt: 1_000,
    speechStartedAt: 1_180,
    speechEndedAt: 1_200,
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
  const result = await coordinator.play(plan, new ArrayBuffer(0));

  assert.equal(requestedDelayMs, 0);
  assert.deepEqual(events, ['audio_start', 'motion_finish']);
  assert.deepEqual(result, {
    speechStartedAt: 1_000,
    speechEndedAt: 1_100,
  });
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
  const playback = coordinator.play(plan, new ArrayBuffer(0));
  coordinator.stop();

  assert.equal(await playback, null);
  assert.deepEqual(events, ['audio_stop', 'motion_stop']);
});
