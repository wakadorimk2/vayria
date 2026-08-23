import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyPositionDeadZone,
  clampAttentionPosition,
  invertHorizontalAttentionPosition,
  normalizeFaceBounds,
  smoothAttentionPosition,
} from '../src/attention/attentionMath.js';
import {
  AttentionStateController,
  type AttentionStateInput,
} from '../src/attention/attentionStateController.js';
import type {
  Attention,
  AttentionFocus,
} from '../src/performer/types.js';
import type { CameraTrackingFrame } from '../src/attention/cameraTrackingController.js';

function createAttention(overrides: Partial<Attention> = {}): Attention {
  return {
    target: 'none',
    strength: 0,
    updatedAt: 0,
    position: null,
    confidence: 0,
    ...overrides,
  };
}

function createInput(
  overrides: Partial<AttentionStateInput> = {},
): AttentionStateInput {
  return {
    now: 0,
    attention: createAttention({
      position: { x: 0.5, y: 0.5 },
      confidence: 1,
    }),
    explicitTargetActive: false,
    viewerEngaged: false,
    thinking: false,
    cameraEnabled: true,
    cameraTracking: createTrackingFrame(),
    ...overrides,
  };
}

function createTrackingFrame(
  overrides: Partial<CameraTrackingFrame> = {},
): CameraTrackingFrame {
  return {
    state: 'Tracking',
    eyePosition: { x: 0.5, y: 0.5 },
    headPosition: { x: 0.5, y: 0.5 },
    focus: createFocus('focused', 1),
    ...overrides,
  };
}

function createFocus(
  phase: AttentionFocus['phase'],
  confidence: number,
): AttentionFocus {
  return { target: 'user', phase, confidence };
}

test('attention coordinates stay inside the configured follow range', () => {
  assert.deepEqual(
    clampAttentionPosition({ x: -1, y: 2 }),
    { x: 0.15, y: 0.85 },
  );
  assert.deepEqual(
    normalizeFaceBounds([
      { x: 0.2, y: 0.25 },
      { x: 0.8, y: 0.75 },
    ]),
    { x: 0.5, y: 0.5 },
  );
  assert.equal(normalizeFaceBounds([{ x: Number.NaN, y: 0.5 }]), null);
});

test('camera attention inverts horizontal input once for real-world left and right', () => {
  const left = invertHorizontalAttentionPosition({ x: 0.2, y: 0.35 });
  assert.ok(Math.abs(left.x - 0.8) < 0.000001);
  assert.equal(left.y, 0.35);

  const right = invertHorizontalAttentionPosition({ x: 0.8, y: 0.65 });
  assert.ok(Math.abs(right.x - 0.2) < 0.000001);
  assert.equal(right.y, 0.65);
});

test('attention dead zone holds small movement and smoothing eases larger movement', () => {
  const previous = { x: 0.5, y: 0.5 };
  assert.deepEqual(
    applyPositionDeadZone({ x: 0.52, y: 0.53 }, previous),
    previous,
  );
  const target = applyPositionDeadZone({ x: 0.6, y: 0.4 }, previous);
  assert.deepEqual(target, { x: 0.6, y: 0.4 });

  const smoothed = smoothAttentionPosition(previous, target, 120);
  assert.ok(smoothed.x > 0.5 && smoothed.x < 0.6);
  assert.ok(smoothed.y < 0.5 && smoothed.y > 0.4);
});

test('idle camera candidate enters AttendViewer after acquisition delay', () => {
  const controller = new AttentionStateController();

  assert.equal(controller.update(createInput({ now: 0 })).state, 'Idle');
  assert.equal(controller.update(createInput({ now: 299 })).state, 'Idle');
  assert.equal(controller.update(createInput({ now: 300 })).state, 'AttendViewer');
  assert.equal(controller.update(createInput({ now: 301 })).target, 'viewer');
});

test('face loss uses grace time and then recovers to idle', () => {
  const controller = new AttentionStateController();
  controller.update(createInput({ now: 0 }));
  controller.update(createInput({ now: 300 }));

  const missingAttention = createAttention({
    position: { x: 0.5, y: 0.5 },
    confidence: 0,
  });
  assert.equal(
    controller.update(
      createInput({
        now: 600,
        attention: missingAttention,
        cameraTracking: createTrackingFrame({
          state: 'Coasting',
          focus: createFocus('holding', 1),
        }),
      }),
    ).state,
    'AttendViewer',
  );
  assert.equal(
    controller.update(
      createInput({
        now: 2_499,
        attention: missingAttention,
        cameraTracking: createTrackingFrame({
          state: 'Uncertain',
          eyePosition: { x: 0.5, y: 0.5 },
          headPosition: { x: 0.7, y: 0.5 },
          focus: createFocus('uncertain', 0.1),
        }),
      }),
    ).state,
    'AttendViewer',
  );
  assert.equal(
    controller.update(
      createInput({
        now: 2_500,
        attention: missingAttention,
        cameraTracking: createTrackingFrame({
          state: 'Lost',
          eyePosition: null,
          headPosition: null,
          focus: createFocus('released', 0),
        }),
      }),
    ).state,
    'Recover',
  );
  assert.equal(
    controller.update(
      createInput({
        now: 2_750,
        attention: missingAttention,
        cameraTracking: createTrackingFrame({
          state: 'Lost',
          eyePosition: null,
          headPosition: null,
          focus: createFocus('released', 0),
        }),
      }),
    ).state,
    'Idle',
  );
});

test('Thinking ignores a camera candidate', () => {
  const controller = new AttentionStateController();
  const thinking = controller.update(
    createInput({ now: 0, thinking: true }),
  );
  assert.equal(thinking.state, 'Thinking');
  assert.equal(thinking.position, null);
  assert.equal(
    controller.update(createInput({ now: 1_000, thinking: true })).state,
    'Thinking',
  );
  assert.equal(
    controller.update(createInput({ now: 1_001 })).state,
    'Recover',
  );
});

test('conversation attention recovers before idle camera reacquisition', () => {
  const controller = new AttentionStateController();
  const engaged = controller.update(
    createInput({ now: 0, viewerEngaged: true }),
  );
  assert.equal(engaged.state, 'AttendViewer');

  const ended = controller.update(createInput({ now: 1 }));
  assert.equal(ended.state, 'Recover');
  assert.equal(controller.update(createInput({ now: 251 })).state, 'Idle');
});

test('chat and game targets have priority over viewer camera attention', () => {
  const controller = new AttentionStateController();
  assert.equal(
    controller.update(
      createInput({
        attention: createAttention({ target: 'chat', strength: 1 }),
        explicitTargetActive: true,
        viewerEngaged: true,
      }),
    ).state,
    'AttendTarget',
  );
  assert.equal(
    controller.update(
      createInput({
        now: 1,
        attention: createAttention({ target: 'game', strength: 1 }),
        explicitTargetActive: true,
      }),
    ).target,
    'game',
  );
});

test('semantic focus exposes camera uncertainty without expanding AttentionState', () => {
  const controller = new AttentionStateController();
  controller.update(createInput({ now: 0 }));
  controller.update(createInput({ now: 300 }));
  const frame = controller.update(
    createInput({
      now: 301,
      cameraTracking: createTrackingFrame({
        state: 'Uncertain',
        eyePosition: { x: 0.52, y: 0.5 },
        headPosition: { x: 0.7, y: 0.5 },
        focus: createFocus('uncertain', 0.4),
      }),
    }),
  );

  assert.deepEqual(frame.focus, {
    target: 'user',
    phase: 'uncertain',
    confidence: 0.4,
  });
  assert.deepEqual(frame.position, { x: 0.52, y: 0.5 });
  assert.deepEqual(frame.headPosition, { x: 0.7, y: 0.5 });
});
