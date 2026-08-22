import type { VRM } from '@pixiv/three-vrm';
import {
  EMOTIONS,
  VOICE_STYLE_BY_EMOTION,
  VRM_EXPRESSION_BY_EMOTION,
  type Emotion,
} from '../character/emotion';

const TRANSITION_SECONDS = 0.3;

export class EmotionExpressionController {
  readonly missingExpressions: readonly string[];

  private readonly expressionManager: VRM['expressionManager'];
  private readonly expressionByEmotion = new Map<Emotion, string | null>();
  private readonly controlledExpressions = new Set<string>();
  private readonly currentWeights = new Map<string, number>();
  private startWeights = new Map<string, number>();
  private targetExpression: string | null = null;
  private targetEmotion: Emotion | null = null;
  private holdRemainingSeconds = 0;
  private elapsedSeconds = TRANSITION_SECONDS;

  constructor(vrm: VRM) {
    this.expressionManager = vrm.expressionManager;
    const neutralExpression = this.expressionManager?.getExpression('neutral')
      ? 'neutral'
      : null;
    const missingExpressions: string[] = [];

    for (const emotion of EMOTIONS) {
      const expectedExpression = VRM_EXPRESSION_BY_EMOTION[emotion];
      const expression = this.expressionManager?.getExpression(
        expectedExpression,
      )
        ? expectedExpression
        : neutralExpression;

      if (expression !== expectedExpression) {
        missingExpressions.push(expectedExpression);
      }
      this.expressionByEmotion.set(emotion, expression);
      if (expression) this.controlledExpressions.add(expression);
    }

    for (const expression of this.controlledExpressions) {
      this.currentWeights.set(expression, 0);
    }
    this.missingExpressions = missingExpressions;
  }

  getExpressionName(emotion: Emotion): string | null {
    return this.expressionByEmotion.get(emotion) ?? null;
  }

  setEmotion(emotion: Emotion, holdMs = 0): void {
    if (emotion === this.targetEmotion && this.holdRemainingSeconds > 0) {
      return;
    }
    this.applyEmotion(emotion, holdMs);
  }

  private applyEmotion(emotion: Emotion, holdMs: number): void {
    this.startWeights = new Map(this.currentWeights);
    this.targetExpression = this.getExpressionName(emotion);
    this.targetEmotion = emotion;
    this.holdRemainingSeconds = normalizeHoldSeconds(holdMs);
    this.elapsedSeconds = 0;

    console.info(
      `Performer emotion: emotion=${emotion}, vrmExpression=${this.targetExpression ?? '(unavailable)'}, voiceStyle=${VOICE_STYLE_BY_EMOTION[emotion]}`,
    );
  }

  update(deltaSeconds: number): void {
    const safeDelta = Math.min(Math.max(deltaSeconds, 0), 0.1);
    this.holdRemainingSeconds = Math.max(
      0,
      this.holdRemainingSeconds - safeDelta,
    );
    this.elapsedSeconds = Math.min(
      this.elapsedSeconds + safeDelta,
      TRANSITION_SECONDS,
    );
    const progress = this.elapsedSeconds / TRANSITION_SECONDS;

    for (const expression of this.controlledExpressions) {
      const startWeight = this.startWeights.get(expression) ?? 0;
      const targetWeight = expression === this.targetExpression ? 1 : 0;
      const weight = startWeight + (targetWeight - startWeight) * progress;
      this.currentWeights.set(expression, weight);
      this.expressionManager?.setValue(expression, weight);
    }
  }

  dispose(): void {
    for (const expression of this.controlledExpressions) {
      this.expressionManager?.setValue(expression, 0);
    }
    this.currentWeights.clear();
    this.startWeights.clear();
    this.targetEmotion = null;
    this.holdRemainingSeconds = 0;
  }
}

function normalizeHoldSeconds(holdMs: number): number {
  if (!Number.isFinite(holdMs)) return 0;
  return Math.max(0, holdMs) / 1_000;
}
