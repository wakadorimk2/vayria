import { Box3, PerspectiveCamera, Vector3 } from 'three';
import type { VRM } from '@pixiv/three-vrm';
import { STAGE_PRESET } from './stagePreset';

interface CameraFramePreset {
  fov: number;
  visibleHeightRatio: number;
  topPaddingRatio: number;
  distanceMultiplier: number;
}

export function frameAvatar(
  vrm: VRM,
  camera: PerspectiveCamera,
  width: number,
  height: number,
  cameraPreset: CameraFramePreset = STAGE_PRESET.camera,
): void {
  const bounds = new Box3().setFromObject(vrm.scene);
  const size = bounds.getSize(new Vector3());
  const center = bounds.getCenter(new Vector3());
  const modelHeight = Math.max(size.y, 1);
  const aspect = Math.max(width / Math.max(height, 1), 0.1);
  const visibleHeight = modelHeight * cameraPreset.visibleHeightRatio;
  const verticalFov = (cameraPreset.fov * Math.PI) / 180;
  const distance =
    (visibleHeight / (2 * Math.tan(verticalFov / 2))) *
    cameraPreset.distanceMultiplier;
  const targetY =
    bounds.max.y +
    visibleHeight * cameraPreset.topPaddingRatio -
    visibleHeight / 2;

  camera.fov = cameraPreset.fov;
  camera.aspect = aspect;
  camera.position.set(center.x, targetY, center.z + distance);
  camera.near = 0.01;
  camera.far = Math.max(50, distance * 20);
  camera.lookAt(center.x, targetY, center.z);
  camera.updateProjectionMatrix();
}
