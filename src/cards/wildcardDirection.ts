import { useCallback, useEffect, useState } from 'react';
import type {
  DirectionContribution,
  DirectionEffect,
  LiveDirection,
  PerformerTrigger,
} from '../performer/types';
import { getEffectIntensity } from '../performer/runtime';
import { CARD_MODIFIERS } from './cardReactions';
import type { CardSwapResult } from './useCardGamePrototype';
import type { CardZoneState } from './useCardGamePrototype';
import { getCardPerformancePlanOverrides } from './cardMotionAssets';

const FORCED_EFFECT_DURATION_MS = 30_000;
const BACKGROUND_INTENSITY = 0.2;

interface BackgroundEntry {
  startedAt: number;
}

interface WildcardDirectionController {
  direction: LiveDirection;
  activateCardSwap: (result: CardSwapResult) => DirectionContribution;
  updateZones: (nextZones: CardZoneState) => void;
  getContribution: (
    trigger: PerformerTrigger,
    now?: number,
  ) => DirectionContribution;
}

function createBackgroundEffect(
  cardId: string,
  startedAt: number,
): DirectionEffect {
  return {
    id: `wildcard-background-${cardId}`,
    directionId: 'wildcard',
    sourceId: `brain:${cardId}`,
    startedAt,
    intensity: BACKGROUND_INTENSITY,
    decay: 'none',
    modifiers: CARD_MODIFIERS[cardId] ?? {},
  };
}

function createForcedEffect(
  cardId: string,
  animationSequence: number,
  startedAt: number,
): DirectionEffect {
  return {
    id: `wildcard-forced-${animationSequence}`,
    directionId: 'wildcard',
    sourceId: `forced:${cardId}:${animationSequence}`,
    startedAt,
    intensity: 1,
    durationMs: FORCED_EFFECT_DURATION_MS,
    decay: 'exponential',
    modifiers: CARD_MODIFIERS[cardId] ?? {},
  };
}

function createContribution(
  trigger: PerformerTrigger,
  effects: DirectionEffect[],
  now: number,
  requiresSpeech = false,
  planOverrides?: DirectionContribution['planOverrides'],
): DirectionContribution {
  const activeEffects = effects.filter(
    (effect) => getEffectIntensity(effect, now) > 0.001,
  );
  const semanticCues = activeEffects.flatMap(
    (effect) => effect.modifiers.semanticBiases ?? [],
  );
  return {
    directionId: 'wildcard',
    effects: activeEffects,
    constraints: requiresSpeech
      ? [{ kind: 'require_speech', scope: 'current_plan' }]
      : [],
    semanticCues: [...new Set(semanticCues)],
    triggers: [trigger],
    ...(requiresSpeech ? { attentionTarget: 'viewer' as const } : {}),
    ...(planOverrides === undefined ? {} : { planOverrides }),
  };
}

function createController(zones: CardZoneState): WildcardDirectionController {
  let currentBrainCardIds = new Set(zones.brain.map((card) => card.id));
  const backgroundEntries = new Map<string, BackgroundEntry>();
  const forcedEffects: DirectionEffect[] = [];

  const syncBackgroundEntries = (cardIds: readonly string[], now: number) => {
    const ids = new Set(cardIds);
    for (const cardId of cardIds) {
      if (!backgroundEntries.has(cardId)) {
        backgroundEntries.set(cardId, { startedAt: now });
      }
    }
    for (const cardId of backgroundEntries.keys()) {
      if (!ids.has(cardId)) backgroundEntries.delete(cardId);
    }
  };

  const getEffects = (now: number) => {
    syncBackgroundEntries([...currentBrainCardIds], now);
    const backgroundEffects = [...backgroundEntries.entries()].map(
      ([cardId, entry]) => createBackgroundEffect(cardId, entry.startedAt),
    );
    return [...backgroundEffects, ...forcedEffects].filter((effect) => {
      if (getEffectIntensity(effect, now) <= 0.001) return false;
      if (!effect.sourceId.startsWith('forced:')) return true;
      const forcedCardId = effect.sourceId.split(':')[1];
      return currentBrainCardIds.has(forcedCardId);
    });
  };

  const direction: LiveDirection = {
    id: 'wildcard',
    contribute: ({ trigger, now }) =>
      createContribution(trigger, getEffects(now), now),
  };

  return {
    direction,
    updateZones: (nextZones) => {
      currentBrainCardIds = new Set(nextZones.brain.map((card) => card.id));
    },
    activateCardSwap: (result) => {
      const now = Date.now();
      currentBrainCardIds = new Set(result.brainCardIds);
      syncBackgroundEntries(result.brainCardIds, now);
      const forcedEffect = createForcedEffect(
        result.insertedCardId,
        result.animationSequence,
        now,
      );
      forcedEffects.push(forcedEffect);
      const trigger: PerformerTrigger = {
        kind: 'external_stimulus',
        semanticCue: `something_changed:${result.insertedCardId}`,
        metadata: { origin: 'wildcard' },
      };
      return createContribution(
        trigger,
        getEffects(now),
        now,
        true,
        getCardPerformancePlanOverrides(result.insertedCardId),
      );
    },
    getContribution: (trigger, now = Date.now()) =>
      direction.contribute({ trigger, now }),
  };
}

export function useWildcardDirection(
  zones: CardZoneState,
): WildcardDirectionController {
  const [controller] = useState(() => createController(zones));

  useEffect(() => {
    controller.updateZones(zones);
  }, [controller, zones]);

  const activateCardSwap = useCallback(
    (result: CardSwapResult) => controller.activateCardSwap(result),
    [controller],
  );

  const getContribution = useCallback(
    (trigger: PerformerTrigger, now = Date.now()) => {
      return controller.getContribution(trigger, now);
    },
    [controller],
  );

  return {
    direction: controller.direction,
    updateZones: controller.updateZones,
    activateCardSwap,
    getContribution,
  };
}
