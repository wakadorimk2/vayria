import { cardPool } from './cardPool.js';
import { CARD_REACTION_PROFILES } from './cardReactions.js';
import type {
  CardGestureIntent,
  DirectionContribution,
  PerformancePlan,
} from '../performer/types.js';

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

export const CARD_MOTION_ASSET_BY_GESTURE_INTENT: Readonly<
  Record<CardGestureIntent, string>
> = Object.fromEntries(
  cardPool.map((card) => [
    CARD_REACTION_PROFILES[card.id].behavior.gestureIntent,
    CARD_MOTION_ASSET_IDS[card.id],
  ]),
) as Record<CardGestureIntent, string>;

export function getCardPerformancePlanOverrides(
  cardId: string,
  reducedMotion = false,
): NonNullable<DirectionContribution['planOverrides']> {
  const behavior = CARD_REACTION_PROFILES[cardId]?.behavior;
  if (!behavior) {
    throw new Error(`Card behavior is missing "${cardId}".`);
  }

  return reducedMotion
    ? { behavior }
    : {
        behavior,
        motion: {
          assetId: CARD_MOTION_ASSET_BY_GESTURE_INTENT[behavior.gestureIntent],
        },
      };
}

export function attachCardPreviewMotion(
  plan: PerformancePlan,
  cardId: CardMotionCardId,
  reducedMotion: boolean,
): PerformancePlan {
  const overrides = getCardPerformancePlanOverrides(cardId, reducedMotion);
  return {
    ...plan,
    behavior: overrides.behavior,
    motion: overrides.motion,
  } satisfies PerformancePlan;
}
