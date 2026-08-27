import assert from 'node:assert/strict';
import test from 'node:test';
import { Object3D, Vector3 } from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { VrmLookAtBoundaryDriver } from '../src/avatar/vrmLookAtBoundary.js';

class VRMLookAtBoneApplier {
  static readonly type = 'bone';

  applyYawPitch(): void {}

  lookAt(): void {}
}

class VRMLookAtExpressionApplier {
  applyYawPitch(): void {}

  lookAt(): void {}
}

interface FakeLookAt {
  applier: VRMLookAtBoneApplier | VRMLookAtExpressionApplier;
  autoUpdate: boolean;
  pitch: number;
  resetCount: number;
  target: Object3D | null;
  yaw: number;
  lookAt(position: Vector3): void;
  reset(): void;
}

function createFakeVrm(
  applier: FakeLookAt['applier'] = new VRMLookAtBoneApplier(),
): { driver: VrmLookAtBoundaryDriver; lookAt: FakeLookAt; vrm: VRM } {
  const events: string[] = [];
  const scene = new Object3D();
  const originalUpdateMatrixWorld = scene.updateMatrixWorld.bind(scene);
  scene.updateMatrixWorld = ((force?: boolean) => {
    events.push(`scene:${String(force)}`);
    return originalUpdateMatrixWorld(force);
  }) as Object3D['updateMatrixWorld'];
  const target = new Object3D();
  const lookAt: FakeLookAt = {
    applier,
    autoUpdate: true,
    pitch: 0,
    resetCount: 0,
    target,
    yaw: 0,
    lookAt(position) {
      events.push('lookAt');
      this.yaw = position.x;
      this.pitch = position.y - 1;
    },
    reset() {
      events.push('reset');
      this.resetCount += 1;
      this.yaw = 0;
      this.pitch = 0;
    },
  };
  const humanoid = {
    update() {
      events.push('humanoid');
    },
  };
  const vrm = {
    humanoid,
    lookAt,
    scene,
  } as unknown as VRM;
  const driver = new VrmLookAtBoundaryDriver(vrm);
  return { driver, lookAt, vrm };
}

test('boundary driver calculates positive and negative target yaw once', () => {
  const positive = createFakeVrm();
  positive.lookAt.target?.position.set(2, 1, 5);
  const positiveFrame = positive.driver.prepare();

  assert.equal(positiveFrame?.applierType, 'bone');
  assert.ok((positiveFrame?.yawDegrees ?? 0) > 0);
  assert.equal(positiveFrame?.targetActive, true);
  assert.equal(positive.lookAt.autoUpdate, false);
  assert.equal(positive.lookAt.target?.position.x, 2);
  positive.driver.restore();
  assert.equal(positive.lookAt.autoUpdate, true);

  const negative = createFakeVrm();
  negative.lookAt.target?.position.set(-2, 1, 5);
  const negativeFrame = negative.driver.prepare();

  assert.equal(negativeFrame?.applierType, 'bone');
  assert.ok((negativeFrame?.yawDegrees ?? 0) < 0);
  assert.equal(negativeFrame?.targetActive, true);
  negative.driver.restore();
});

test('boundary driver returns the center target to zero', () => {
  const fixture = createFakeVrm();
  fixture.lookAt.target?.position.set(2, 1, 5);
  fixture.driver.prepare();
  fixture.driver.restore();

  fixture.lookAt.target?.position.set(0, 1, 5);
  const frame = fixture.driver.prepare();

  assert.equal(frame?.yawDegrees, 0);
  assert.equal(frame?.pitchDegrees, 0);
  assert.equal(fixture.lookAt.target?.position.x, 0);
  fixture.driver.restore();
});

test('boundary driver preserves target identity and restores a disabled autoUpdate', () => {
  const fixture = createFakeVrm();
  const target = fixture.lookAt.target;
  fixture.lookAt.autoUpdate = false;

  const frame = fixture.driver.prepare();

  assert.equal(frame?.targetActive, true);
  assert.equal(fixture.lookAt.target, target);
  assert.equal(fixture.lookAt.autoUpdate, false);
  fixture.driver.restore();
  assert.equal(fixture.lookAt.target, target);
  assert.equal(fixture.lookAt.autoUpdate, false);
});

test('boundary driver resets without a target and detects applier class names', () => {
  const fixture = createFakeVrm(new VRMLookAtExpressionApplier());
  fixture.lookAt.target = null;

  const frame = fixture.driver.prepare();

  assert.equal(frame?.applierType, 'expression');
  assert.equal(frame?.targetActive, false);
  assert.equal(frame?.yawDegrees, 0);
  assert.equal(frame?.pitchDegrees, 0);
  assert.equal(fixture.lookAt.resetCount, 1);
  assert.equal(fixture.lookAt.autoUpdate, false);
  fixture.driver.restore();
  assert.equal(fixture.lookAt.autoUpdate, true);
});

test('boundary driver orders pose sync, world matrices, and one lookAt call', () => {
  const events: string[] = [];
  const scene = new Object3D();
  const originalUpdateMatrixWorld = scene.updateMatrixWorld.bind(scene);
  scene.updateMatrixWorld = ((force?: boolean) => {
    events.push(`scene:${String(force)}`);
    return originalUpdateMatrixWorld(force);
  }) as Object3D['updateMatrixWorld'];
  const target = new Object3D();
  target.position.set(1, 1, 4);
  const lookAt: FakeLookAt = {
    applier: new VRMLookAtBoneApplier(),
    autoUpdate: true,
    pitch: 0,
    resetCount: 0,
    target,
    yaw: 0,
    lookAt() {
      events.push('lookAt');
    },
    reset() {
      events.push('reset');
    },
  };
  const vrm = {
    humanoid: {
      update() {
        events.push('humanoid');
      },
    },
    lookAt,
    scene,
  } as unknown as VRM;
  const driver = new VrmLookAtBoundaryDriver(vrm);

  driver.prepare();

  assert.deepEqual(events, ['humanoid', 'scene:true', 'lookAt']);
  driver.restore();
});
