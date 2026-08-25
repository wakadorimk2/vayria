import type { VRM } from '@pixiv/three-vrm';
import type { LifeDynamicsSnapshot } from './lifeDynamics.js';
import { getBlinkExpressionNames } from './blinkExpressions.js';

/**
 * Projects the LifeDynamics blink snapshot onto the VRM eye expressions.
 *
 * The adapter owns no clock or temporal state. It applies an absolute weight
 * from the current snapshot and clears that weight during reset or disposal.
 */
export class LifeDynamicsBlinkAdapter {
  private readonly expressionManager: VRM['expressionManager'];
  private readonly expressionNames: readonly string[];

  constructor(vrm: VRM) {
    this.expressionManager = vrm.expressionManager;
    this.expressionNames = getBlinkExpressionNames(vrm);
  }

  apply(snapshot: LifeDynamicsSnapshot): void {
    this.setWeight(clamp(snapshot.blink.weight));
  }

  reset(): void {
    this.setWeight(0);
  }

  dispose(): void {
    this.reset();
  }

  private setWeight(weight: number): void {
    for (const expressionName of this.expressionNames) {
      this.expressionManager?.setValue(expressionName, weight);
    }
  }
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, 1));
}
