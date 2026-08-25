import { VRMExpressionPresetName } from '@pixiv/three-vrm';
import type { VRM } from '@pixiv/three-vrm';

export function getBlinkExpressionNames(vrm: VRM): readonly string[] {
  const manager = vrm.expressionManager;

  if (manager?.getExpression(VRMExpressionPresetName.Blink)) {
    return [VRMExpressionPresetName.Blink];
  }

  const hasLeft = manager?.getExpression(VRMExpressionPresetName.BlinkLeft);
  const hasRight = manager?.getExpression(
    VRMExpressionPresetName.BlinkRight,
  );
  return hasLeft && hasRight
    ? [
        VRMExpressionPresetName.BlinkLeft,
        VRMExpressionPresetName.BlinkRight,
      ]
    : [];
}
