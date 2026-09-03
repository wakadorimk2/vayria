export const SPEECH_ACTS = [
  'react',
  'answer',
  'agree',
  'disagree',
  'question',
  'tease',
  'complain',
  'joke',
  'connect',
  'narrate',
] as const;

export type SpeechAct = (typeof SPEECH_ACTS)[number];

export const EXPRESSION_LEVELS = ['low', 'medium', 'high'] as const;

export type ExpressionLevel = (typeof EXPRESSION_LEVELS)[number];

export interface UtterancePlan {
  speechAct: SpeechAct;
  expressionLevel: ExpressionLevel;
  activatedCards: readonly [string] | readonly [string, string];
}

const EXPRESSION_RANK: Readonly<Record<ExpressionLevel, number>> = {
  low: 0,
  medium: 1,
  high: 2,
};

export function isSpeechAct(value: unknown): value is SpeechAct {
  return (
    typeof value === 'string' &&
    (SPEECH_ACTS as readonly string[]).includes(value)
  );
}

export function isExpressionLevel(value: unknown): value is ExpressionLevel {
  return (
    typeof value === 'string' &&
    (EXPRESSION_LEVELS as readonly string[]).includes(value)
  );
}

export function isWithinExpressionBudget(
  level: ExpressionLevel,
  budget: ExpressionLevel,
): boolean {
  return EXPRESSION_RANK[level] <= EXPRESSION_RANK[budget];
}

export function resolveExpressionBudget(options: {
  mode: 'manual' | 'voice' | 'autonomous';
  forcedCardEnergy: 'low' | 'medium' | 'high' | null;
  recentExpressionLevels: readonly ExpressionLevel[];
}): ExpressionLevel {
  if (options.mode === 'autonomous' && options.forcedCardEnergy === null) {
    return 'low';
  }
  if (
    options.forcedCardEnergy === 'high' &&
    !options.recentExpressionLevels.slice(-10).includes('high')
  ) {
    return 'high';
  }
  return 'medium';
}
