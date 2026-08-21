import type { WildcardCardData } from './WildcardCard';

export const cardPool = [
  { id: 'chicken', label: '鶏', kind: 'concept' },
  { id: 'suspicious', label: '疑心暗鬼', kind: 'mood' },
  { id: 'gigantic', label: '巨大', kind: 'effect' },
  { id: 'tiny', label: 'ちいさい', kind: 'effect' },
  { id: 'sleepy', label: '眠い', kind: 'mood' },
  { id: 'curious', label: '好奇心', kind: 'mood' },
  { id: 'hungry', label: 'お腹すいた', kind: 'mood' },
  { id: 'rain', label: '雨', kind: 'concept' },
  { id: 'secret', label: '秘密', kind: 'concept' },
  { id: 'panic', label: 'パニック', kind: 'mood' },
  { id: 'sparkle', label: 'きらきら', kind: 'effect' },
  { id: 'underwater', label: '水中', kind: 'effect' },
  { id: 'lonely', label: 'さみしい', kind: 'mood' },
  { id: 'confident', label: '自信満々', kind: 'mood' },
  { id: 'strange', label: 'なんか変', kind: 'concept' },
  { id: 'deja-vu', label: '既視感', kind: 'concept' },
  { id: 'distant-thunder', label: '遠雷', kind: 'concept' },
  { id: 'upside-down', label: '逆さま', kind: 'effect' },
] as const satisfies readonly WildcardCardData[];
