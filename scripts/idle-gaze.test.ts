import assert from 'node:assert/strict';
import test from 'node:test';
import { Object3D, Vector3 } from 'three';
import type { VRM } from '@pixiv/three-vrm';
import {
  IDLE_GAZE_TIMING,
  IdleGazeController,
} from '../src/avatar/idleGaze.js';

interface FakeLookAt {
  getLookAtWorldPosition(target: Vector3): Vector3;
  resetCount: number;
  target: Object3D | null;
  reset(): void;
}

function createFakeVrm(withLookAt = true): {
  lookAt: FakeLookAt | undefined;
  vrm: VRM;
} {
  const lookAt: FakeLookAt | undefined = withLookAt
    ? {
        getLookAtWorldPosition(target) {
          return target.set(0, 1, 2);
        },
        resetCount: 0,
        target: null,
        reset() {
          this.resetCount += 1;
        },
      }
    : undefined;

  return {
    lookAt,
    vrm: {
      lookAt,
      scene: {
        updateMatrixWorld() {},
      },
    } as unknown as VRM,
  };
}

function advance(
  controller: IdleGazeController,
  seconds: number,
  target = new Vector3(0, 1, 5),
  enabled = true,
  performanceTarget: Vector3 | null = null,
): ReturnType<IdleGazeController['update']> {
  let frame = controller.update(0, target, enabled, performanceTarget);
  let remaining = seconds;
  while (remaining > 0) {
    const delta = Math.min(0.1, remaining);
    frame = controller.update(delta, target, enabled, performanceTarget);
    remaining -= delta;
  }
  return frame;
}

function advanceUntil(
  controller: IdleGazeController,
  predicate: (frame: ReturnType<IdleGazeController['update']>) => boolean,
  target = new Vector3(0, 1, 5),
  maxSeconds = 20,
): number {
  let elapsed = 0;
  let frame = controller.update(0, target, true);
  while (elapsed < maxSeconds) {
    frame = controller.update(0.05, target, true);
    elapsed += 0.05;
    if (predicate(frame)) return elapsed;
  }
  throw new Error(`Condition was not reached within ${maxSeconds} seconds.`);
}

test('idle gaze waits before the first viewer glance', () => {
  const { lookAt, vrm } = createFakeVrm();
  const controller = new IdleGazeController(vrm, 2, () => 0);

  const waitingFrame = advance(controller, 4.9);
  assert.equal(waitingFrame.phase, 'waiting');
  assert.equal(lookAt?.target, null);

  const glanceFrame = advance(controller, 0.2);
  assert.equal(glanceFrame.phase, 'glancing');
  assert.notEqual(lookAt?.target, null);
});

test('idle gaze randomizes wait and hold durations within their ranges', () => {
  const minFixture = createFakeVrm();
  const minController = new IdleGazeController(minFixture.vrm, 2, () => 0);
  const minWaitSeconds = advanceUntil(
    minController,
    (frame) => frame.phase === 'glancing',
  );
  const minGlanceSeconds = advanceUntil(
    minController,
    (frame) => frame.phase === 'returning',
  );

  assert.ok(minWaitSeconds >= IDLE_GAZE_TIMING.minWaitSeconds);
  assert.ok(
    minWaitSeconds <= IDLE_GAZE_TIMING.minWaitSeconds + 0.1,
  );
  assert.ok(
    minGlanceSeconds >=
      IDLE_GAZE_TIMING.approachSeconds + IDLE_GAZE_TIMING.minHoldSeconds,
  );
  assert.ok(
    minGlanceSeconds <=
      IDLE_GAZE_TIMING.approachSeconds +
        IDLE_GAZE_TIMING.minHoldSeconds +
        0.1,
  );

  const maxFixture = createFakeVrm();
  const maxController = new IdleGazeController(maxFixture.vrm, 2, () => 1);
  const maxWaitSeconds = advanceUntil(
    maxController,
    (frame) => frame.phase === 'glancing',
  );
  const maxGlanceSeconds = advanceUntil(
    maxController,
    (frame) => frame.phase === 'returning',
  );

  assert.ok(maxWaitSeconds >= IDLE_GAZE_TIMING.maxWaitSeconds);
  assert.ok(maxWaitSeconds <= IDLE_GAZE_TIMING.maxWaitSeconds + 0.1);
  assert.ok(
    maxGlanceSeconds >=
      IDLE_GAZE_TIMING.approachSeconds + IDLE_GAZE_TIMING.maxHoldSeconds,
  );
  assert.ok(
    maxGlanceSeconds <=
      IDLE_GAZE_TIMING.approachSeconds +
        IDLE_GAZE_TIMING.maxHoldSeconds +
        0.1,
  );
});

test('idle gaze holds and then returns to the neutral direction', () => {
  const { lookAt, vrm } = createFakeVrm();
  const controller = new IdleGazeController(vrm, 2, () => 0);

  advance(controller, IDLE_GAZE_TIMING.minWaitSeconds + 0.1);
  const returningFrame = advance(
    controller,
    IDLE_GAZE_TIMING.approachSeconds +
      IDLE_GAZE_TIMING.minHoldSeconds +
      0.1,
  );
  assert.equal(returningFrame.phase, 'returning');
  assert.notEqual(lookAt?.target, null);

  const waitingFrame = advance(
    controller,
    IDLE_GAZE_TIMING.returnSeconds + 0.1,
  );
  assert.equal(waitingFrame.phase, 'waiting');
  assert.equal(lookAt?.target, null);
  assert.equal(lookAt?.resetCount, 1);
});

test('idle gaze keeps positive and negative offsets within model-relative bounds', () => {
  const positiveRandomValues = [0, 1, 1, 1];
  const positiveFixture = createFakeVrm();
  const positiveController = new IdleGazeController(
    positiveFixture.vrm,
    2,
    () => positiveRandomValues.shift() ?? 0,
  );
  const viewerTarget = new Vector3(0, 1, 5);

  advance(
    positiveController,
    IDLE_GAZE_TIMING.minWaitSeconds + 0.1,
    viewerTarget,
  );
  advance(positiveController, 0.4, viewerTarget);

  const positiveTarget = positiveFixture.lookAt?.target;
  assert.ok(positiveTarget);
  assert.ok(
    positiveTarget.position.x <=
      viewerTarget.x + 2 * IDLE_GAZE_TIMING.maxHorizontalOffsetRatio,
  );
  assert.ok(
    positiveTarget.position.y <=
      viewerTarget.y + 2 * IDLE_GAZE_TIMING.maxVerticalOffsetRatio,
  );

  const negativeRandomValues = [0, 0, 0, 1];
  const negativeFixture = createFakeVrm();
  const negativeController = new IdleGazeController(
    negativeFixture.vrm,
    2,
    () => negativeRandomValues.shift() ?? 0,
  );

  advance(negativeController, IDLE_GAZE_TIMING.minWaitSeconds + 0.1, viewerTarget);
  advance(negativeController, 0.4, viewerTarget);

  const negativeTarget = negativeFixture.lookAt?.target;
  assert.ok(negativeTarget);
  assert.ok(
    negativeTarget.position.x >=
      viewerTarget.x - 2 * IDLE_GAZE_TIMING.maxHorizontalOffsetRatio,
  );
  assert.ok(
    negativeTarget.position.y >=
      viewerTarget.y - 2 * IDLE_GAZE_TIMING.maxVerticalOffsetRatio,
  );
});

test('disabled idle gaze returns smoothly and re-arms without a stuck target', () => {
  const { lookAt, vrm } = createFakeVrm();
  const controller = new IdleGazeController(vrm, 2, () => 0);

  advance(controller, IDLE_GAZE_TIMING.minWaitSeconds + 0.1);
  assert.notEqual(lookAt?.target, null);

  const disabledFrame = controller.update(
    0.1,
    new Vector3(0, 1, 5),
    false,
  );
  assert.equal(disabledFrame.phase, 'returning');
  assert.notEqual(lookAt?.target, null);

  const returnedFrame = advance(
    controller,
    IDLE_GAZE_TIMING.returnSeconds + 0.1,
    new Vector3(0, 1, 5),
    false,
  );
  assert.equal(returnedFrame.phase, 'waiting');
  assert.equal(lookAt?.target, null);

  const reEnabledFrame = controller.update(
    0.1,
    new Vector3(0, 1, 5),
    true,
  );
  assert.equal(reEnabledFrame.phase, 'waiting');
});

test('performance gaze holds the viewer target and returns after release', () => {
  const { lookAt, vrm } = createFakeVrm();
  const controller = new IdleGazeController(vrm, 2, () => 0);
  const viewerTarget = new Vector3(0, 1, 5);

  const activeFrame = advance(
    controller,
    IDLE_GAZE_TIMING.approachSeconds + 0.1,
    viewerTarget,
    false,
    viewerTarget,
  );
  assert.equal(activeFrame.phase, 'glancing');
  assert.equal(activeFrame.isLookingAtViewer, true);
  assert.notEqual(lookAt?.target, null);

  const returningFrame = controller.update(
    0.1,
    viewerTarget,
    false,
    null,
  );
  assert.equal(returningFrame.phase, 'returning');
  assert.notEqual(lookAt?.target, null);

  const waitingFrame = advance(
    controller,
    IDLE_GAZE_TIMING.returnSeconds + 0.1,
    viewerTarget,
    false,
  );
  assert.equal(waitingFrame.phase, 'waiting');
  assert.equal(lookAt?.target, null);
});

test('idle gaze stays inactive while a performance plan is active', () => {
  const { lookAt, vrm } = createFakeVrm();
  const controller = new IdleGazeController(vrm, 2, () => 0);
  const viewerTarget = new Vector3(0, 1, 5);

  let frame = controller.update(0, viewerTarget, false);
  for (let index = 0; index < 160; index += 1) {
    frame = controller.update(0.1, viewerTarget, false);
  }

  assert.equal(frame.phase, 'waiting');
  assert.equal(frame.isLookingAtViewer, false);
  assert.equal(lookAt?.target, null);
});

test('models without VRM LookAt use the head-yaw fallback without throwing', () => {
  const { vrm } = createFakeVrm(false);
  const controller = new IdleGazeController(vrm, 2, () => 0);

  const waitingFrame = advance(
    controller,
    IDLE_GAZE_TIMING.minWaitSeconds + 0.1,
  );
  assert.equal(waitingFrame.phase, 'glancing');
  const activeFrame = advance(controller, 0.1);
  assert.ok(activeFrame.fallbackHeadYawBias > 0);
});
