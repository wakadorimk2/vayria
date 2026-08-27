import { Vector3 } from 'three';
import type { VRM } from '@pixiv/three-vrm';

type VrmLookAt = NonNullable<VRM['lookAt']>;

export type VrmLookAtApplierType = 'bone' | 'expression' | 'unknown';

export interface VrmLookAtBoundaryFrame {
  readonly applierType: VrmLookAtApplierType;
  readonly targetActive: boolean;
  readonly yawDegrees: number;
  readonly pitchDegrees: number;
}

/**
 * Prepares the VRM LookAt calculation at the boundary between Vayria and
 * three-vrm.
 *
 * Vayria writes the normalized humanoid pose before VRM.update(). The
 * boundary driver makes that pose visible to three-vrm before it calculates
 * the target angle, then disables automatic recalculation for the same VRM
 * update. It never replaces or clears the controller-owned target.
 */
export class VrmLookAtBoundaryDriver {
  private readonly targetWorldPosition = new Vector3();
  private activeLookAt: VrmLookAt | null = null;
  private previousAutoUpdate: boolean | null = null;

  constructor(private readonly vrm: VRM) {}

  get applierType(): VrmLookAtApplierType {
    const lookAt = this.vrm.lookAt;
    return lookAt === undefined ? 'unknown' : readApplierType(lookAt);
  }

  /**
   * Synchronizes the current pose and freezes one target-to-angle calculation
   * for the following VRM.update() call.
   */
  prepare(): VrmLookAtBoundaryFrame | null {
    const lookAt = this.vrm.lookAt;
    if (lookAt === undefined) return null;

    this.restore();
    this.activeLookAt = lookAt;
    this.previousAutoUpdate = lookAt.autoUpdate;

    try {
      this.vrm.humanoid.update();
      this.vrm.scene.updateMatrixWorld(true);

      const target = lookAt.target;
      if (target != null) {
        lookAt.lookAt(target.getWorldPosition(this.targetWorldPosition));
      } else {
        lookAt.reset();
      }

      lookAt.autoUpdate = false;

      return {
        applierType: readApplierType(lookAt),
        targetActive: target != null,
        yawDegrees: lookAt.yaw,
        pitchDegrees: lookAt.pitch,
      };
    } catch (error) {
      this.restore();
      throw error;
    }
  }

  /**
   * Restores the LookAt automatic-update setting after VRM.update().
   */
  restore(): void {
    if (this.activeLookAt !== null && this.previousAutoUpdate !== null) {
      this.activeLookAt.autoUpdate = this.previousAutoUpdate;
    }
    this.activeLookAt = null;
    this.previousAutoUpdate = null;
  }

  dispose(): void {
    this.restore();
  }
}

function readApplierType(lookAt: VrmLookAt): VrmLookAtApplierType {
  const constructor = lookAt.applier?.constructor as {
    readonly type?: unknown;
    readonly name?: unknown;
  };
  const declaredType =
    typeof constructor.type === 'string'
      ? constructor.type
      : typeof constructor.name === 'string'
        ? constructor.name
        : '';
  const normalizedType = declaredType.toLowerCase();

  if (normalizedType === 'bone' || normalizedType.includes('bone')) {
    return 'bone';
  }
  if (
    normalizedType === 'expression' ||
    normalizedType.includes('expression')
  ) {
    return 'expression';
  }
  return 'unknown';
}
