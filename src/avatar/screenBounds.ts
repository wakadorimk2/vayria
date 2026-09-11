import { Mesh, SkinnedMesh, Vector3, type Object3D, type PerspectiveCamera } from 'three';

export interface AvatarScreenBounds {
  viewportWidth: number;
  left: number;
  right: number;
}

// Capture the base pose once; animations must not make the settings panel oscillate.
export function captureAvatarPoints(root: Object3D): Vector3[] {
  root.updateMatrixWorld(true);
  const points: Vector3[] = [];
  root.traverseVisible(object => {
    if (!(object instanceof Mesh) || !object.visible) return;
    if (object instanceof SkinnedMesh) object.skeleton.update();
    const count = object.geometry.getAttribute('position')?.count ?? 0;
    for (let index = 0; index < count; index++) {
      points.push(object.getVertexPosition(index, new Vector3()).applyMatrix4(object.matrixWorld));
    }
  });
  return points;
}

export function projectAvatarBounds(points: readonly Vector3[], camera: PerspectiveCamera, width: number): AvatarScreenBounds | null {
  camera.updateMatrixWorld(true);
  const projected = new Vector3();
  let left = Infinity, right = -Infinity;
  for (const point of points) {
    projected.copy(point).project(camera);
    // Only the part visible vertically can compete with a full-height side panel.
    if (projected.y < -1 || projected.y > 1 || projected.z < -1 || projected.z > 1) continue;
    const x = (projected.x + 1) * width / 2;
    left = Math.min(left, x); right = Math.max(right, x);
  }
  return Number.isFinite(left) && Number.isFinite(right) ? { viewportWidth: width, left, right } : null;
}
