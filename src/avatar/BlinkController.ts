import { VRM, VRMExpressionPresetName } from '@pixiv/three-vrm';

const BLINK_TIMING = {
  maxDeltaSeconds: 0.1,
  initialIntervalSeconds: [1.2, 3.5],
  intervalSeconds: [2.8, 6.5],
  closeSeconds: 0.075,
  holdSeconds: 0.04,
  openSeconds: 0.13,
} as const;

type BlinkState = 'waiting' | 'blinking';

function randomBetween([minimum, maximum]: readonly [number, number]): number {
  return minimum + Math.random() * (maximum - minimum);
}

export class BlinkController {
  private readonly expressionManager: VRM['expressionManager'];
  private readonly expressionNames: readonly string[];
  private enabled = true;
  private state: BlinkState = 'waiting';
  private waitSeconds = randomBetween(BLINK_TIMING.initialIntervalSeconds);
  private blinkElapsedSeconds = 0;

  constructor(vrm: VRM) {
    this.expressionManager = vrm.expressionManager;
    const manager = this.expressionManager;

    if (manager?.getExpression(VRMExpressionPresetName.Blink)) {
      this.expressionNames = [VRMExpressionPresetName.Blink];
      return;
    }

    const hasLeft = manager?.getExpression(VRMExpressionPresetName.BlinkLeft);
    const hasRight = manager?.getExpression(
      VRMExpressionPresetName.BlinkRight,
    );
    this.expressionNames =
      hasLeft && hasRight
        ? [
            VRMExpressionPresetName.BlinkLeft,
            VRMExpressionPresetName.BlinkRight,
          ]
        : [];
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    this.openEyes();
    this.state = 'waiting';
    this.blinkElapsedSeconds = 0;
    this.waitSeconds = randomBetween(BLINK_TIMING.intervalSeconds);
  }

  update(deltaSeconds: number): void {
    if (!this.enabled || this.expressionNames.length === 0) return;

    const safeDelta = Math.min(
      Math.max(deltaSeconds, 0),
      BLINK_TIMING.maxDeltaSeconds,
    );
    if (this.state === 'waiting') {
      this.waitSeconds -= safeDelta;
      if (this.waitSeconds > 0) return;
      this.state = 'blinking';
      this.blinkElapsedSeconds = 0;
    }

    this.blinkElapsedSeconds += safeDelta;
    const closeEnd = BLINK_TIMING.closeSeconds;
    const holdEnd = closeEnd + BLINK_TIMING.holdSeconds;
    const blinkEnd = holdEnd + BLINK_TIMING.openSeconds;

    if (this.blinkElapsedSeconds < closeEnd) {
      this.setWeight(this.blinkElapsedSeconds / BLINK_TIMING.closeSeconds);
      return;
    }
    if (this.blinkElapsedSeconds < holdEnd) {
      this.setWeight(1);
      return;
    }
    if (this.blinkElapsedSeconds < blinkEnd) {
      this.setWeight(
        1 -
          (this.blinkElapsedSeconds - holdEnd) / BLINK_TIMING.openSeconds,
      );
      return;
    }

    this.openEyes();
    this.state = 'waiting';
    this.blinkElapsedSeconds = 0;
    this.waitSeconds = randomBetween(BLINK_TIMING.intervalSeconds);
  }

  dispose(): void {
    this.openEyes();
  }

  private openEyes(): void {
    this.setWeight(0);
  }

  private setWeight(weight: number): void {
    for (const expressionName of this.expressionNames) {
      this.expressionManager?.setValue(expressionName, weight);
    }
  }
}
