import { Box3, PerspectiveCamera, Vector3 } from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { STAGE_PRESET } from './stagePreset';

export function frameAvatar(
  vrm: VRM,
  camera: PerspectiveCamera,
  width: number,
  height: number,
): void {
  const bounds = new Box3().setFromObject(vrm.scene);
  const size = bounds.getSize(new Vector3());
  const center = bounds.getCenter(new Vector3());
  const modelHeight = Math.max(size.y, 1);
  const aspect = Math.max(width / Math.max(height, 1), 0.1);
  const visibleHeight = modelHeight * STAGE_PRESET.camera.visibleHeightRatio;
  const verticalFov = (STAGE_PRESET.camera.fov * Math.PI) / 180;
  const distance =
    (visibleHeight / (2 * Math.tan(verticalFov / 2))) *
    STAGE_PRESET.camera.distanceMultiplier;
  const targetY =
    bounds.max.y +
    visibleHeight * STAGE_PRESET.camera.topPaddingRatio -
    visibleHeight / 2;

  camera.fov = STAGE_PRESET.camera.fov;
  camera.aspect = aspect;
  camera.position.set(center.x, targetY, center.z + distance);
  camera.near = 0.01;
  camera.far = Math.max(50, distance * 20);
  camera.lookAt(center.x, targetY, center.z);
  camera.updateProjectionMatrix();
}
