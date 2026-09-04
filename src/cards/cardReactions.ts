import type {
  DirectionContribution,
  DirectionModifiers,
  PerformanceBehavior,
  PerformerTrigger,
} from '../performer/types.js';

export const M1_INITIAL_BRAIN_CARD_IDS = [
  'chicken',
  'suspicious',
  'sleepy',
  'rain',
  'gigantic',
] as const;

export const CARD_REACTION_AXES = [
  { id: 'meaning', label: '意味' },
  { id: 'speech', label: '発話' },
  { id: 'gaze', label: '視線' },
  { id: 'voice', label: '音声' },
  { id: 'motion', label: 'モーション' },
] as const;

export type CardReactionAxis = (typeof CARD_REACTION_AXES)[number]['id'];
export type CardReactionModifierKey = keyof DirectionModifiers;

export interface CardReactionProfile {
  cardId: string;
  modifiers: Partial<DirectionModifiers>;
  axisSummaries: Readonly<Record<CardReactionAxis, string>>;
  behavior: PerformanceBehavior;
}

export const CARD_REACTION_MODIFIER_FIELDS: Readonly<
  Record<CardReactionAxis, readonly CardReactionModifierKey[]>
> = {
  meaning: ['semanticBiases'],
  speech: ['responseDelayMs', 'speechFragmentation'],
  gaze: ['gazeDirectness', 'attentionStrength'],
  voice: ['ttsRateScale', 'ttsIntonationScale'],
  motion: ['idleMotionWeight', 'headYawBias'],
};

export const CARD_REACTION_UNMAPPED_FIELDS = [
  'initiative',
  'emotionalInertia',
] as const satisfies readonly CardReactionModifierKey[];

export const CARD_REACTION_VISIBLE_FIELDS = [
  'gazeDirectness',
  'attentionStrength',
  'idleMotionWeight',
  'headYawBias',
] as const satisfies readonly CardReactionModifierKey[];

const CARD_PREVIEW_EFFECT_DURATION_MS = 30_000;

export const CARD_INTERACTION_ATTENTION_CHANCE = 0.35;
export const CARD_INTERACTION_CUE_DURATION_MS = 300;
export const CARD_INTERACTION_ATTENTION_DURATION_MS = 900;

export function shouldReactToCardInteraction(random = Math.random): boolean {
  const value = random();
  return (
    Number.isFinite(value) &&
    value >= 0 &&
    value < CARD_INTERACTION_ATTENTION_CHANCE
  );
}

export const CARD_BEHAVIORS: Readonly<
  Record<string, PerformanceBehavior>
> = {
  chicken: {
    stance: 'inquisitive',
    energy: 'medium',
    engagement: 'cautious',
    gestureIntent: 'inspect',
  },
  suspicious: {
    stance: 'skeptical',
    energy: 'medium',
    engagement: 'cautious',
    gestureIntent: 'withdraw',
  },
  gigantic: {
    stance: 'awed',
    energy: 'high',
    engagement: 'direct',
    gestureIntent: 'expand',
  },
  tiny: {
    stance: 'timid',
    energy: 'low',
    engagement: 'inward',
    gestureIntent: 'contract',
  },
  sleepy: {
    stance: 'drowsy',
    energy: 'low',
    engagement: 'inward',
    gestureIntent: 'release',
  },
  curious: {
    stance: 'curious',
    energy: 'medium',
    engagement: 'direct',
    gestureIntent: 'lean_in',
  },
  hungry: {
    stance: 'seeking',
    energy: 'medium',
    engagement: 'inward',
    gestureIntent: 'self_hold',
  },
  rain: {
    stance: 'weathered',
    energy: 'low',
    engagement: 'cautious',
    gestureIntent: 'look_up',
  },
  secret: {
    stance: 'secretive',
    energy: 'low',
    engagement: 'cautious',
    gestureIntent: 'conceal',
  },
  panic: {
    stance: 'alarmed',
    energy: 'high',
    engagement: 'direct',
    gestureIntent: 'brace',
  },
  sparkle: {
    stance: 'delighted',
    energy: 'high',
    engagement: 'direct',
    gestureIntent: 'open',
  },
  underwater: {
    stance: 'buoyant',
    energy: 'low',
    engagement: 'distant',
    gestureIntent: 'sway',
  },
  lonely: {
    stance: 'withdrawn',
    energy: 'low',
    engagement: 'distant',
    gestureIntent: 'lower',
  },
  confident: {
    stance: 'assertive',
    energy: 'high',
    engagement: 'direct',
    gestureIntent: 'present',
  },
  strange: {
    stance: 'uncanny',
    energy: 'low',
    engagement: 'distant',
    gestureIntent: 'freeze',
  },
  'deja-vu': {
    stance: 'uncertain',
    energy: 'low',
    engagement: 'distant',
    gestureIntent: 'stare',
  },
  'distant-thunder': {
    stance: 'vigilant',
    energy: 'medium',
    engagement: 'cautious',
    gestureIntent: 'scan',
  },
  'upside-down': {
    stance: 'disoriented',
    energy: 'medium',
    engagement: 'cautious',
    gestureIntent: 'orient',
  },
};

export const CARD_MODIFIERS: Readonly<
  Record<string, Partial<DirectionModifiers>>
> = {
  suspicious: {
    responseDelayMs: 260,
    emotionalInertia: 0.28,
    speechFragmentation: 0.12,
    gazeDirectness: -0.35,
    attentionStrength: -0.08,
    idleMotionWeight: -0.05,
    headYawBias: -0.55,
    ttsIntonationScale: -0.08,
    semanticBiases: ['断定を弱める', '相手の意図を一度確認する'],
  },
  sleepy: {
    responseDelayMs: 180,
    initiative: -0.25,
    speechFragmentation: 0.1,
    ttsRateScale: -0.12,
    ttsIntonationScale: -0.16,
    idleMotionWeight: -0.25,
    headYawBias: -0.8,
    semanticBiases: ['短くゆるく返す', '説明を少し省略する'],
  },
  curious: {
    initiative: 0.2,
    callbackTendency: 0.25,
    gazeDirectness: 0.24,
    attentionStrength: 0.18,
    idleMotionWeight: 0.08,
    headYawBias: 0.55,
    ttsIntonationScale: 0.08,
    semanticBiases: ['気になる点を短く残す'],
  },
  chicken: {
    gazeDirectness: 0.12,
    attentionStrength: 0.08,
    idleMotionWeight: 0.06,
    headYawBias: 0.7,
    semanticBiases: ['鶏に関係する具体物を一つ連想する'],
  },
  gigantic: {
    gazeDirectness: -0.08,
    attentionStrength: 0.12,
    idleMotionWeight: 0.18,
    headYawBias: 1.2,
    semanticBiases: ['物事を一箇所だけ大きなスケールで見る'],
  },
  tiny: {
    gazeDirectness: -0.08,
    attentionStrength: 0.16,
    idleMotionWeight: -0.12,
    headYawBias: -0.9,
    semanticBiases: ['小さな音や細部へ焦点を寄せる'],
  },
  rain: {
    gazeDirectness: -0.1,
    attentionStrength: 0.06,
    idleMotionWeight: -0.15,
    headYawBias: -0.35,
    semanticBiases: ['雨音や湿り気を短く連想する'],
  },
  secret: {
    speechFragmentation: 0.08,
    gazeDirectness: -0.22,
    attentionStrength: -0.08,
    idleMotionWeight: -0.1,
    headYawBias: -0.55,
    semanticBiases: ['言いかけて余白を残す'],
  },
  sparkle: {
    gazeDirectness: 0.14,
    attentionStrength: 0.1,
    idleMotionWeight: 0.16,
    headYawBias: 0.45,
    ttsIntonationScale: 0.08,
    semanticBiases: ['光や華やかさを一箇所だけ強調する'],
  },
  panic: {
    responseDelayMs: -90,
    speechFragmentation: 0.18,
    gazeDirectness: 0.1,
    attentionStrength: 0.22,
    idleMotionWeight: 0.12,
    headYawBias: 1,
    ttsRateScale: 0.08,
    semanticBiases: ['短い焦りや未完了の思考を一箇所だけ入れる'],
  },
  hungry: {
    gazeDirectness: 0.08,
    attentionStrength: 0.12,
    idleMotionWeight: 0.08,
    headYawBias: 0.65,
    semanticBiases: ['身体感覚や食べ物を一箇所だけ連想する'],
  },
  underwater: {
    responseDelayMs: 140,
    gazeDirectness: -0.12,
    attentionStrength: -0.1,
    idleMotionWeight: -0.18,
    headYawBias: -0.45,
    ttsRateScale: -0.08,
    semanticBiases: ['音や思考を少し遠くぼんやりさせる'],
  },
  lonely: {
    emotionalInertia: 0.12,
    gazeDirectness: -0.18,
    attentionStrength: -0.12,
    idleMotionWeight: -0.1,
    headYawBias: -0.65,
    ttsIntonationScale: -0.08,
    semanticBiases: ['文末に小さな空白感を残す'],
  },
  confident: {
    gazeDirectness: 0.22,
    attentionStrength: 0.12,
    idleMotionWeight: 0.05,
    headYawBias: 0.4,
    ttsIntonationScale: 0.05,
    semanticBiases: ['迷いのない断定を一箇所だけ入れる'],
  },
  strange: {
    speechFragmentation: 0.08,
    gazeDirectness: 0.12,
    attentionStrength: 0.08,
    idleMotionWeight: 0.04,
    headYawBias: 0.9,
    semanticBiases: ['普通の状況に小さな違和感を指摘する'],
  },
  'deja-vu': {
    emotionalInertia: 0.08,
    gazeDirectness: -0.06,
    attentionStrength: -0.04,
    idleMotionWeight: -0.08,
    headYawBias: -0.3,
    semanticBiases: ['以前にもあったような反復感を残す'],
  },
  'distant-thunder': {
    responseDelayMs: 90,
    gazeDirectness: -0.1,
    attentionStrength: 0.04,
    idleMotionWeight: 0.08,
    headYawBias: 0.6,
    semanticBiases: ['まだ起きていない変化の気配を示す'],
  },
  'upside-down': {
    gazeDirectness: -0.1,
    attentionStrength: 0.14,
    idleMotionWeight: 0.14,
    headYawBias: -1.1,
    semanticBiases: ['常識や因果を一箇所だけ反転させる'],
  },
};

const NEUTRAL_SUMMARY = '中立';

const CARD_AXIS_SUMMARIES: Readonly<
  Record<string, Readonly<Record<CardReactionAxis, string>>>
> = {
  chicken: {
    meaning: '鶏に関係する具体物を1つ連想',
    speech: NEUTRAL_SUMMARY,
    gaze: '視線を少し前へ向ける',
    voice: NEUTRAL_SUMMARY,
    motion: '首振りを少し強める',
  },
  suspicious: {
    meaning: '断定を弱め、相手の意図を一度確認',
    speech: '返答を少し遅らせ、話し方を断片化',
    gaze: '視線の直接性と注目を弱める',
    voice: '抑揚を少し弱める',
    motion: '首を少し横へそらす',
  },
  sleepy: {
    meaning: '短くゆるく返し、説明を少し省略',
    speech: '返答を遅らせ、話し方を断片化',
    gaze: NEUTRAL_SUMMARY,
    voice: '話速と抑揚を弱める',
    motion: 'アイドル動作と首振りを弱める',
  },
  rain: {
    meaning: '雨音や湿り気を短く連想',
    speech: NEUTRAL_SUMMARY,
    gaze: '視線を少し落ち着かせる',
    voice: NEUTRAL_SUMMARY,
    motion: 'アイドル動作を静かにする',
  },
  gigantic: {
    meaning: '物事を1箇所だけ大きなスケールで見る',
    speech: NEUTRAL_SUMMARY,
    gaze: '注目を広げ、視線を少し前へ向ける',
    voice: NEUTRAL_SUMMARY,
    motion: 'アイドル動作と首振りを大きくする',
  },
  tiny: {
    meaning: '小さな音や細部へ焦点を寄せる',
    speech: NEUTRAL_SUMMARY,
    gaze: '細部へ注目を寄せる',
    voice: NEUTRAL_SUMMARY,
    motion: 'アイドル動作と首振りを小さくする',
  },
  curious: {
    meaning: '気になる点を短く残す',
    speech: NEUTRAL_SUMMARY,
    gaze: '視線と注目を強める',
    voice: '抑揚を少し強める',
    motion: '小さく首をかしげる',
  },
  hungry: {
    meaning: '身体感覚や食べ物を一箇所だけ連想',
    speech: NEUTRAL_SUMMARY,
    gaze: '注目を少し前へ寄せる',
    voice: NEUTRAL_SUMMARY,
    motion: '首振りを少し強める',
  },
  secret: {
    meaning: '言いかけた内容を隠して余白を残す',
    speech: '話し方を少し断片化',
    gaze: '視線と注目を控えめにする',
    voice: NEUTRAL_SUMMARY,
    motion: '首を少し横へそらす',
  },
  sparkle: {
    meaning: '光や華やかさを一箇所だけ強調',
    speech: NEUTRAL_SUMMARY,
    gaze: '視線と注目を少し強める',
    voice: '抑揚を少し強める',
    motion: 'アイドル動作を少し強める',
  },
  panic: {
    meaning: '短い焦りや未完了の思考を一箇所だけ入れる',
    speech: '返答を早め、話し方を断片化',
    gaze: '注目を強める',
    voice: '話速を少し強める',
    motion: '首振りとアイドル動作を強める',
  },
  underwater: {
    meaning: '音や思考を少し遠くぼんやりさせる',
    speech: '返答を少し遅らせる',
    gaze: '視線と注目を弱める',
    voice: '話速を弱める',
    motion: 'アイドル動作と首振りを弱める',
  },
  lonely: {
    meaning: '文末に小さな空白感を残す',
    speech: NEUTRAL_SUMMARY,
    gaze: '視線と注目を弱める',
    voice: '抑揚を少し弱める',
    motion: 'アイドル動作と首振りを弱める',
  },
  confident: {
    meaning: '迷いのない断定を一箇所だけ入れる',
    speech: NEUTRAL_SUMMARY,
    gaze: '視線と注目を強める',
    voice: '抑揚を少し強める',
    motion: '首振りを少し強める',
  },
  strange: {
    meaning: '普通の状況に小さな違和感を指摘',
    speech: '話し方を少し断片化',
    gaze: '注目を少し強める',
    voice: NEUTRAL_SUMMARY,
    motion: '首振りを少し強める',
  },
  'deja-vu': {
    meaning: '以前にもあったような反復感を残す',
    speech: NEUTRAL_SUMMARY,
    gaze: '視線と注目を少し弱める',
    voice: NEUTRAL_SUMMARY,
    motion: 'アイドル動作と首振りを少し弱める',
  },
  'distant-thunder': {
    meaning: 'まだ起きていない変化の気配を示す',
    speech: '返答を少し遅らせる',
    gaze: '注目を少し強める',
    voice: NEUTRAL_SUMMARY,
    motion: 'アイドル動作と首振りを少し強める',
  },
  'upside-down': {
    meaning: '常識や因果を一箇所だけ反転',
    speech: NEUTRAL_SUMMARY,
    gaze: '注目を強め、視線を横へ寄せる',
    voice: NEUTRAL_SUMMARY,
    motion: '首振りとアイドル動作を強める',
  },
};

export const CARD_REACTION_PROFILES: Readonly<
  Record<string, CardReactionProfile>
> = Object.fromEntries(
  Object.entries(CARD_MODIFIERS).map(([cardId, modifiers]) => [
    cardId,
    {
      cardId,
      modifiers,
      axisSummaries: CARD_AXIS_SUMMARIES[cardId],
      behavior: CARD_BEHAVIORS[cardId],
    },
  ]),
) as Record<string, CardReactionProfile>;

export function createCardPreviewContribution(
  cardId: string,
  now = Date.now(),
): DirectionContribution {
  const modifiers = CARD_MODIFIERS[cardId];
  if (!modifiers) {
    throw new Error(`Card modifier is missing "${cardId}".`);
  }
  const behavior = CARD_REACTION_PROFILES[cardId]?.behavior;
  if (!behavior) {
    throw new Error(`Card behavior is missing "${cardId}".`);
  }

  const trigger: PerformerTrigger = {
    kind: 'external_stimulus',
    semanticCue: `card_preview:${cardId}`,
    metadata: { origin: 'card-preview' },
  };

  return {
    directionId: 'card-preview',
    effects: [
      {
        id: `card-preview-${cardId}-${now}`,
        directionId: 'card-preview',
        sourceId: `preview:${cardId}`,
        startedAt: now,
        intensity: 1,
        durationMs: CARD_PREVIEW_EFFECT_DURATION_MS,
        decay: 'exponential',
        modifiers,
      },
    ],
    constraints: [{ kind: 'require_speech', scope: 'current_plan' }],
    semanticCues: [],
    triggers: [trigger],
    attentionTarget: 'viewer',
    planOverrides: { behavior },
  };
}
