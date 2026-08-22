import { cardPool } from './cardPool.js';
import type { PerformancePlan } from '../performer/types.js';

export type CardMotionCardId = (typeof cardPool)[number]['id'];

export const CARD_MOTION_ASSET_IDS: Readonly<
  Record<CardMotionCardId, `card-${CardMotionCardId}`>
> = {
  chicken: 'card-chicken',
  suspicious: 'card-suspicious',
  gigantic: 'card-gigantic',
  tiny: 'card-tiny',
  sleepy: 'card-sleepy',
  curious: 'card-curious',
  hungry: 'card-hungry',
  rain: 'card-rain',
  secret: 'card-secret',
  panic: 'card-panic',
  sparkle: 'card-sparkle',
  underwater: 'card-underwater',
  lonely: 'card-lonely',
  confident: 'card-confident',
  strange: 'card-strange',
  'deja-vu': 'card-deja-vu',
  'distant-thunder': 'card-distant-thunder',
  'upside-down': 'card-upside-down',
};

export function attachCardPreviewMotion(
  plan: PerformancePlan,
  cardId: CardMotionCardId,
  reducedMotion: boolean,
): PerformancePlan {
  if (reducedMotion) return plan;

  return {
    ...plan,
    motion: { assetId: CARD_MOTION_ASSET_IDS[cardId] },
  };
}
