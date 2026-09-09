import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build, transform } from 'esbuild';
import { readFile } from 'node:fs/promises';
const { code } = await transform(await readFile('src/public/settingsLayout.ts', 'utf8'), { loader: 'ts', format: 'esm' });
const { calculateSettingsLayout: layout } = await import('data:text/javascript,' + encodeURIComponent(code));
const bounds = (viewportWidth, left, right) => ({ viewportWidth, left, right });

test('unloaded, invalid, and phone bounds use the panel without moving the avatar', () => {
  for (const b of [null, bounds(1440, NaN, 800), bounds(1440, 800, 200), bounds(767, 300, 400)]) {
    assert.deepEqual(layout(b), { mode: 'panel', width: 0, avatarOffset: 0 });
  }
});
test('sidebar consumes only free space, caps at 480, and leaves both gaps', () => {
  assert.deepEqual(layout(bounds(1440, 420, 1000)), { mode: 'sidebar', width: 400, avatarOffset: 0 });
  assert.deepEqual(layout(bounds(1920, 650, 1250)), { mode: 'sidebar', width: 480, avatarOffset: 0 });
  assert.deepEqual(layout(bounds(1000, 200, 680)), { mode: 'sidebar', width: 280, avatarOffset: 0 });
});
test('only the deficit is shifted and the left boundary is inclusive', () => {
  assert.deepEqual(layout(bounds(1024, 200, 800)), { mode: 'sidebar', width: 280, avatarOffset: 96 });
  assert.deepEqual(layout(bounds(1024, 112, 800)), { mode: 'sidebar', width: 280, avatarOffset: 96 });
  assert.deepEqual(layout(bounds(1024, 111, 800)), { mode: 'panel', width: 0, avatarOffset: 0 });
});
test('portrait cannot fit without shrinking; resize uses fresh unshifted bounds', () => {
  assert.equal(layout(bounds(768, -20, 788)).mode, 'panel');
  const normal = bounds(1024, 200, 800);
  assert.equal(layout(normal).avatarOffset, 96);
  assert.equal(layout(bounds(1440, 420, 1000)).avatarOffset, 0);
  assert.equal(layout(bounds(768, 16, 752)).avatarOffset, 0);
});

test('camera view offset moves the projected avatar left without scaling it', async () => {
  const bundle = await build({ stdin: { contents: 'export { projectAvatarBounds } from "./src/avatar/screenBounds"; export { PerspectiveCamera, Vector3 } from "three";', resolveDir: process.cwd() }, bundle: true, write: false, format: 'esm', platform: 'node' });
  const { projectAvatarBounds, PerspectiveCamera, Vector3 } = await import('data:text/javascript;base64,' + Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  const camera = new PerspectiveCamera(30, 1024 / 768, .01, 50);
  camera.position.set(0, 0, 5); camera.lookAt(0, 0, 0);
  const points = [new Vector3(-1, 0, 0), new Vector3(1, 0, 0), new Vector3(100, 100, 0)];
  const original = projectAvatarBounds(points, camera, 1024);
  camera.setViewOffset(1024, 768, 96, 0, 1024, 768);
  const shifted = projectAvatarBounds(points, camera, 1024);
  assert.ok(Math.abs(original.left - shifted.left - 96) < 1e-8);
  assert.ok(Math.abs(original.right - shifted.right - 96) < 1e-8);
  camera.clearViewOffset();
  assert.deepEqual(projectAvatarBounds(points, camera, 1024), original);
  assert.equal(projectAvatarBounds([], camera, 1024), null);
});
