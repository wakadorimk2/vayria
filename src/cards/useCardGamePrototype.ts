import { useCallback, useState } from 'react';
import { cardPool } from './cardPool';
import type { WildcardCardData } from './WildcardCard';

const MAX_STAMINA = 1;

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
  stamina: number;
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
    stamina: MAX_STAMINA,
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
      if (zones.stamina === 0) return;
      const setSelected =
        zone === 'brain' ? setSelectedBrainCardId : setSelectedHandCardId;
      setSelected((current) => (current === cardId ? null : cardId));
    },
    [zones.stamina],
  );

  const swapSelectedCards = useCallback(() => {
    if (!selectedBrainCardId || !selectedHandCardId) return;

    setZones((current) => {
      if (current.stamina === 0) return current;
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

      return { brain, hand, stamina: 0 };
    });
    setSelectedBrainCardId(null);
    setSelectedHandCardId(null);
  }, [selectedBrainCardId, selectedHandCardId]);

  const resetTurn = useCallback(() => {
    setZones((current) => ({ ...current, stamina: MAX_STAMINA }));
    setSelectedBrainCardId(null);
    setSelectedHandCardId(null);
  }, []);

  return {
    maxStamina: MAX_STAMINA,
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
