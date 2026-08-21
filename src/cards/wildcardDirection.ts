import { useCallback, useEffect, useState } from 'react';
import type {
  DirectionContribution,
  DirectionEffect,
  LiveDirection,
  PerformerTrigger,
} from '../performer/types';
import { getEffectIntensity } from '../performer/runtime';
import type { CardSwapResult } from './useCardGamePrototype';
import type { CardZoneState } from './useCardGamePrototype';

const FORCED_EFFECT_DURATION_MS = 30_000;
const BACKGROUND_INTENSITY = 0.2;

const CARD_MODIFIERS: Record<string, DirectionEffect['modifiers']> = {
  suspicious: {
    responseDelayMs: 260,
    emotionalInertia: 0.28,
    speechFragmentation: 0.12,
    gazeDirectness: -0.35,
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
    ttsIntonationScale: 0.08,
    semanticBiases: ['気になる点を短く残す'],
  },
  chicken: {
    semanticBiases: ['鶏に関係する具体物を一つ連想する'],
  },
  gigantic: {
    semanticBiases: ['物事を一箇所だけ大きなスケールで見る'],
  },
  tiny: {
    semanticBiases: ['小さな音や細部へ焦点を寄せる'],
  },
  rain: {
    semanticBiases: ['雨音や湿り気を短く連想する'],
  },
  secret: {
    speechFragmentation: 0.08,
    semanticBiases: ['言いかけて余白を残す'],
  },
  sparkle: {
    ttsIntonationScale: 0.08,
    semanticBiases: ['光や華やかさを一箇所だけ強調する'],
  },
  panic: {
    responseDelayMs: -90,
    speechFragmentation: 0.18,
    ttsRateScale: 0.08,
    semanticBiases: ['短い焦りや未完了の思考を一箇所だけ入れる'],
  },
  hungry: {
    semanticBiases: ['身体感覚や食べ物を一箇所だけ連想する'],
  },
  underwater: {
    responseDelayMs: 140,
    ttsRateScale: -0.08,
    semanticBiases: ['音や思考を少し遠くぼんやりさせる'],
  },
  lonely: {
    emotionalInertia: 0.12,
    ttsIntonationScale: -0.08,
    semanticBiases: ['文末に小さな空白感を残す'],
  },
  confident: {
    gazeDirectness: 0.22,
    ttsIntonationScale: 0.05,
    semanticBiases: ['迷いのない断定を一箇所だけ入れる'],
  },
  strange: {
    speechFragmentation: 0.08,
    semanticBiases: ['普通の状況に小さな違和感を指摘する'],
  },
  'deja-vu': {
    emotionalInertia: 0.08,
    semanticBiases: ['以前にもあったような反復感を残す'],
  },
  'distant-thunder': {
    responseDelayMs: 90,
    semanticBiases: ['まだ起きていない変化の気配を示す'],
  },
  'upside-down': {
    semanticBiases: ['常識や因果を一箇所だけ反転させる'],
  },
};

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
): DirectionContribution {
  const activeEffects = effects.filter(
    (effect) => getEffectIntensity(effect, now) > 0.001,
  );
  const semanticCues = activeEffects.flatMap(
    (effect) => effect.modifiers.semanticBiases ?? [],
  );
  const isCardInsertion =
    trigger.kind === 'external_stimulus' && trigger.source === 'wildcard';

  return {
    directionId: 'wildcard',
    effects: activeEffects,
    constraints: isCardInsertion
      ? [{ kind: 'require_speech', scope: 'current_plan' }]
      : [],
    semanticCues: [...new Set(semanticCues)],
    triggers: [trigger],
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
        source: 'wildcard',
        semanticCue: `something_changed:${result.insertedCardId}`,
      };
      return createContribution(trigger, getEffects(now), now);
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
