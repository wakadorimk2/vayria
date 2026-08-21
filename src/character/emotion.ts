export const EMOTIONS = [
  'neutral',
  'fun',
  'joy',
  'sorrow',
  'angry',
  'surprised',
] as const;

export type Emotion = (typeof EMOTIONS)[number];

export interface AssistantResponse {
  text: string;
  emotion: Emotion;
}

export const VRM_EXPRESSION_BY_EMOTION: Record<Emotion, string> = {
  neutral: 'neutral',
  fun: 'relaxed',
  joy: 'happy',
  sorrow: 'sad',
  angry: 'angry',
  surprised: 'surprised',
};

export const VOICE_STYLE_BY_EMOTION: Record<Emotion, string> = {
  neutral: 'ノーマル',
  fun: 'B',
  joy: 'C',
  sorrow: 'A',
  angry: 'D',
  surprised: 'ノーマル',
};

export const ZONOKO_SPEAKER_NAME = 'zonoko';

export const AIVIS_VOICE_PARAMETERS = {
  speedScale: 1.15,
  pitchScale: 0,
  intonationScale: 1,
  tempoDynamicsScale: 1,
} as const;

export function normalizeEmotion(value: unknown): Emotion {
  return typeof value === 'string' &&
    (EMOTIONS as readonly string[]).includes(value)
    ? (value as Emotion)
    : 'neutral';
}
