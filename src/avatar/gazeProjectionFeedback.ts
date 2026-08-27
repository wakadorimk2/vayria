import {
  Euler,
  MathUtils,
  Object3D,
  Quaternion,
  Vector3,
} from 'three';
import type { ViewerHeadBias } from './attentionTarget.js';
import type { GazeAllocationBasis } from './gazeAllocation.js';

export interface GazeFaceFrontProvider {
  getFaceFrontQuaternion(target: Quaternion): Quaternion;
}

export interface GazeProjectionOffset {
  readonly head: ViewerHeadBias;
  readonly neck: ViewerHeadBias;
}

/**
 * Carries only the previous frame's gaze rotation into the next allocation.
 * Idle motion, expressions, and VRMA pose changes are intentionally excluded.
 */
export class GazeProjectionFeedback {
  private readonly offsetEuler = new Euler(0, 0, 0, 'XYZ');
  private readonly headOffset = new Quaternion();
  private readonly neckOffset = new Quaternion();
  private readonly combinedOffset = new Quaternion();
  private readonly worldRotation = new Quaternion();
  private readonly faceFrontRotation = new Quaternion();
  private readonly projectedRotation = new Quaternion();
  private readonly forward = new Vector3();
  private readonly right = new Vector3();
  private readonly up = new Vector3();
  private offset: GazeProjectionOffset = createZeroOffset();

  set(offset: GazeProjectionOffset): void {
    if (!isFiniteBias(offset.head) || !isFiniteBias(offset.neck)) {
      this.reset();
      return;
    }
    this.offset = {
      head: { ...offset.head },
      neck: { ...offset.neck },
    };
  }

  reset(): void {
    this.offset = createZeroOffset();
  }

  createNeutralBasis(
    headNode: Object3D | null,
    faceFrontProvider: GazeFaceFrontProvider | null,
    output: GazeAllocationBasis,
  ): GazeAllocationBasis | null {
    return this.createBasis(headNode, faceFrontProvider, output, false);
  }

  createHeadBasis(
    headNode: Object3D | null,
    faceFrontProvider: GazeFaceFrontProvider | null,
    output: GazeAllocationBasis,
  ): GazeAllocationBasis | null {
    return this.createBasis(headNode, faceFrontProvider, output, true);
  }

  private createBasis(
    headNode: Object3D | null,
    faceFrontProvider: GazeFaceFrontProvider | null,
    output: GazeAllocationBasis,
    includeFeedback: boolean,
  ): GazeAllocationBasis | null {
    if (!headNode) return null;
    headNode.getWorldQuaternion(this.worldRotation);
    if (!isFiniteQuaternion(this.worldRotation)) return null;

    this.faceFrontRotation.identity();
    if (faceFrontProvider) {
      faceFrontProvider.getFaceFrontQuaternion(this.faceFrontRotation);
    }
    if (!isFiniteQuaternion(this.faceFrontRotation)) return null;

    this.projectedRotation.copy(this.worldRotation);
    if (includeFeedback) {
      setOffsetQuaternion(this.headOffset, this.offsetEuler, this.offset.head);
      setOffsetQuaternion(this.neckOffset, this.offsetEuler, this.offset.neck);
      this.combinedOffset
        .copy(this.neckOffset)
        .multiply(this.headOffset);
      this.projectedRotation.multiply(this.combinedOffset);
    }
    this.projectedRotation.multiply(this.faceFrontRotation);

    this.forward
      .set(0, 0, 1)
      .applyQuaternion(this.projectedRotation)
      .normalize();
    this.right.set(1, 0, 0).applyQuaternion(this.projectedRotation).normalize();
    this.up.set(0, 1, 0).applyQuaternion(this.projectedRotation).normalize();
    if (
      !isFiniteVector(this.forward) ||
      !isFiniteVector(this.right) ||
      !isFiniteVector(this.up)
    ) {
      return null;
    }

    output.forward.copy(this.forward);
    output.right.copy(this.right);
    output.up.copy(this.up);
    return output;
  }
}

function setOffsetQuaternion(
  output: Quaternion,
  euler: Euler,
  bias: ViewerHeadBias,
): void {
  euler.set(
    MathUtils.degToRad(bias.pitchDegrees),
    MathUtils.degToRad(bias.yawDegrees),
    0,
  );
  output.setFromEuler(euler);
}

function createZeroOffset(): GazeProjectionOffset {
  return {
    head: { yawDegrees: 0, pitchDegrees: 0 },
    neck: { yawDegrees: 0, pitchDegrees: 0 },
  };
}

function isFiniteBias(value: ViewerHeadBias): boolean {
  return (
    Number.isFinite(value.yawDegrees) && Number.isFinite(value.pitchDegrees)
  );
}

function isFiniteQuaternion(value: Quaternion): boolean {
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z) &&
    Number.isFinite(value.w)
  );
}

function isFiniteVector(value: Vector3): boolean {
  return (
    Number.isFinite(value.x) &&
    Number.isFinite(value.y) &&
    Number.isFinite(value.z)
  );
}
