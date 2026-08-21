import { useCallback, useState } from 'react';
import { cardPool } from './cardPool';
import type { WildcardCardData } from './cardTypes';

const MAX_INTERFERENCE_COUNT = 1;

const INITIAL_BRAIN_IDS = [
  'chicken',
  'suspicious',
  'sleepy',
  'rain',
  'gigantic',
] as const;

const INITIAL_HAND_IDS = [
  'tiny',
  'curious',
  'secret',
  'sparkle',
  'panic',
] as const;

export type CardZone = 'brain' | 'hand';

export interface CardZoneState {
  brain: WildcardCardData[];
  hand: WildcardCardData[];
  remainingInterferenceCount: number;
  activatedCardIds: string[];
  forcedCardId: string | null;
}

function selectCards(ids: readonly string[]): WildcardCardData[] {
  return ids.map((id) => {
    const card = cardPool.find((candidate) => candidate.id === id);
    if (!card) throw new Error(`Card pool is missing "${id}".`);
    return card;
  });
}

function createInitialState(): CardZoneState {
  return {
    brain: selectCards(INITIAL_BRAIN_IDS),
    hand: selectCards(INITIAL_HAND_IDS),
    remainingInterferenceCount: MAX_INTERFERENCE_COUNT,
    activatedCardIds: [],
    forcedCardId: null,
  };
}

export function useCardGamePrototype() {
  const [zones, setZones] = useState<CardZoneState>(createInitialState);
  const [selectedBrainCardId, setSelectedBrainCardId] = useState<
    string | null
  >(null);
  const [selectedHandCardId, setSelectedHandCardId] = useState<string | null>(
    null,
  );

  const selectCard = useCallback(
    (zone: CardZone, cardId: string) => {
      if (zones.remainingInterferenceCount === 0) return;
      const setSelected =
        zone === 'brain' ? setSelectedBrainCardId : setSelectedHandCardId;
      setSelected((current) => (current === cardId ? null : cardId));
    },
    [zones.remainingInterferenceCount],
  );

  const swapSelectedCards = useCallback(() => {
    if (!selectedBrainCardId || !selectedHandCardId) return;

    setZones((current) => {
      if (current.remainingInterferenceCount === 0) return current;
      const brainIndex = current.brain.findIndex(
        (card) => card.id === selectedBrainCardId,
      );
      const handIndex = current.hand.findIndex(
        (card) => card.id === selectedHandCardId,
      );
      if (brainIndex < 0 || handIndex < 0) return current;

      const brain = [...current.brain];
      const hand = [...current.hand];
      [brain[brainIndex], hand[handIndex]] = [
        hand[handIndex],
        brain[brainIndex],
      ];

      return {
        brain,
        hand,
        remainingInterferenceCount: 0,
        activatedCardIds: [],
        forcedCardId: brain[brainIndex].id,
      };
    });
    setSelectedBrainCardId(null);
    setSelectedHandCardId(null);
  }, [selectedBrainCardId, selectedHandCardId]);

  const resetTurn = useCallback(() => {
    setZones((current) => ({
      ...current,
      remainingInterferenceCount: MAX_INTERFERENCE_COUNT,
      activatedCardIds: [],
      forcedCardId: null,
    }));
    setSelectedBrainCardId(null);
    setSelectedHandCardId(null);
  }, []);

  const beginReply = useCallback(() => {
    setZones((current) => ({ ...current, activatedCardIds: [] }));
  }, []);

  const acceptReply = useCallback((activatedCardIds: string[]) => {
    setZones((current) => {
      const brainCardIds = new Set(current.brain.map((card) => card.id));
      return {
        ...current,
        remainingInterferenceCount: MAX_INTERFERENCE_COUNT,
        activatedCardIds: activatedCardIds.filter((id) => brainCardIds.has(id)),
        forcedCardId: null,
      };
    });
  }, []);

  return {
    maxInterferenceCount: MAX_INTERFERENCE_COUNT,
    acceptReply,
    beginReply,
    resetTurn,
    selectCard,
    selectedBrainCardId,
    selectedHandCardId,
    swapSelectedCards,
    zones,
  };
}

export type CardGamePrototypeController = ReturnType<
  typeof useCardGamePrototype
>;
