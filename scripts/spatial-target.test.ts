import assert from 'node:assert/strict';
import test from 'node:test';
import { PerspectiveCamera, Vector3 } from 'three';
import {
  SpatialTargetRegistry,
  type SpatialTargetElement,
} from '../src/attention/spatialTargetRegistry.js';
import { SpatialTargetBridge } from '../src/avatar/spatialTargetBridge.js';

function createElement(
  left: number,
  top: number,
  width: number,
  height: number,
): SpatialTargetElement & {
  calls: number;
  rect: { left: number; top: number; width: number; height: number };
} {
  const element = {
    calls: 0,
    isConnected: true,
    rect: { left, top, width, height },
    getBoundingClientRect() {
      element.calls += 1;
      return element.rect;
    },
  };
  return element;
}

test('registry captures an element center once and does not follow later DOM movement', () => {
  const registry = new SpatialTargetRegistry();
  const defaultElement = createElement(100, 200, 200, 100);
  const transientElement = createElement(400, 300, 100, 200);

  assert.equal(registry.registerDefault('game', defaultElement), true);
  assert.equal(registry.captureTransient('game', transientElement), true);
  assert.equal(transientElement.calls, 1);

  transientElement.rect.left = 900;
  transientElement.rect.top = 900;
  const snapshot = registry.resolve({ kind: 'game', anchor: 'transient' });

  assert.deepEqual(snapshot?.point, { x: 450, y: 400 });
  assert.equal(transientElement.calls, 1);
});

test('a disconnected transient element resolves to the cached default anchor', () => {
  const registry = new SpatialTargetRegistry();
  const defaultElement = createElement(0, 0, 100, 100);
  const transientElement = createElement(400, 0, 100, 100);

  registry.registerDefault('game', defaultElement);
  registry.captureTransient('game', transientElement);
  transientElement.isConnected = false;

  const snapshot = registry.resolve({ kind: 'game', anchor: 'transient' });

  assert.equal(snapshot?.selection.anchor, 'default');
  assert.deepEqual(snapshot?.point, { x: 50, y: 50 });
});

test('refreshDefault reads a moved default element only after layout invalidation', () => {
  const registry = new SpatialTargetRegistry();
  const element = createElement(0, 0, 100, 100);

  registry.registerDefault('chat', element);
  element.rect.left = 200;
  element.rect.top = 300;
  assert.deepEqual(
    registry.resolve({ kind: 'chat', anchor: 'default' })?.point,
    { x: 50, y: 50 },
  );

  registry.refreshDefault('chat');
  assert.deepEqual(
    registry.resolve({ kind: 'chat', anchor: 'default' })?.point,
    { x: 250, y: 350 },
  );
  assert.equal(element.calls, 2);
});

function createBridgeCamera(): PerspectiveCamera {
  const camera = new PerspectiveCamera(60, 1, 0.1, 100);
  camera.position.set(0, 0, 5);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld(true);
  return camera;
}

function createSnapshot(x: number, y: number) {
  return {
    selection: { kind: 'game' as const, anchor: 'default' as const },
    point: { x, y },
    capturedAt: 0,
  };
}

test('bridge moves the world target right for a right-side card', () => {
  const bridge = new SpatialTargetBridge();
  const result = bridge.resolve({
    camera: createBridgeCamera(),
    eyePosition: new Vector3(0, 0, 0),
    neutralTarget: new Vector3(0, 0, 0),
    snapshot: createSnapshot(750, 500),
    stageRect: { left: 0, top: 0, width: 1_000, height: 1_000 },
  });

  assert.ok(result);
  assert.ok(result.target.x > 0);
  assert.ok(Number.isFinite(result.target.x));
  assert.ok(Number.isFinite(result.target.y));
  assert.ok(Number.isFinite(result.target.z));
});

test('bridge moves the world target down for a lower conversation region', () => {
  const bridge = new SpatialTargetBridge();
  const result = bridge.resolve({
    camera: createBridgeCamera(),
    eyePosition: new Vector3(0, 0, 0),
    neutralTarget: new Vector3(0, 0, 0),
    snapshot: createSnapshot(500, 750),
    stageRect: { left: 0, top: 0, width: 1_000, height: 1_000 },
  });

  assert.ok(result);
  assert.ok(result.target.y < 0);
});

test('bridge clamps head bias and rejects invalid stage geometry', () => {
  const bridge = new SpatialTargetBridge();
  const result = bridge.resolve({
    camera: createBridgeCamera(),
    eyePosition: new Vector3(0, 0, 0),
    neutralTarget: new Vector3(0, 0, 0),
    snapshot: createSnapshot(10_000, -10_000),
    stageRect: { left: 0, top: 0, width: 1_000, height: 1_000 },
  });

  assert.ok(result);
  assert.ok(Math.abs(result.headBias.yawDegrees) <= 8);
  assert.ok(Math.abs(result.headBias.pitchDegrees) <= 6);
  assert.equal(
    bridge.resolve({
      camera: createBridgeCamera(),
      eyePosition: new Vector3(0, 0, 0),
      neutralTarget: new Vector3(0, 0, 0),
      snapshot: createSnapshot(500, 500),
      stageRect: { left: 0, top: 0, width: 0, height: 1_000 },
    }),
    null,
  );
});
