import { useCallback, useRef, useState } from 'react';
import { cardPool } from './cardPool';
import { M1_INITIAL_BRAIN_CARD_IDS } from './cardReactions';
import type { WildcardCardData } from './cardTypes';

const MAX_INTERFERENCE_COUNT = 1;

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

export interface CardSwapResult {
  animationSequence: number;
  brainCardIds: string[];
  ejectedCardId: string;
  forcedCardId: string;
  insertedCardId: string;
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
    brain: selectCards(M1_INITIAL_BRAIN_CARD_IDS),
    hand: selectCards(INITIAL_HAND_IDS),
    remainingInterferenceCount: MAX_INTERFERENCE_COUNT,
    activatedCardIds: [],
    forcedCardId: null,
  };
}

export function useCardGamePrototype() {
  const [zones, setZones] = useState<CardZoneState>(createInitialState);
  const swapSequenceRef = useRef(0);
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

  const swapCards = useCallback(
    (brainCardId: string, handCardId: string): CardSwapResult | null => {
      if (zones.remainingInterferenceCount === 0) return null;

      const brainIndex = zones.brain.findIndex(
        (card) => card.id === brainCardId,
      );
      const handIndex = zones.hand.findIndex((card) => card.id === handCardId);
      if (brainIndex < 0 || handIndex < 0) return null;

      const brain = [...zones.brain];
      const hand = [...zones.hand];
      const insertedCard = hand[handIndex];
      const ejectedCard = brain[brainIndex];
      [brain[brainIndex], hand[handIndex]] = [insertedCard, ejectedCard];

      const animationSequence = swapSequenceRef.current + 1;
      swapSequenceRef.current = animationSequence;
      setZones((current) => {
        if (current.remainingInterferenceCount === 0) return current;

        return {
          brain,
          hand,
          remainingInterferenceCount: 0,
          activatedCardIds: [],
          forcedCardId: insertedCard.id,
        };
      });

      setSelectedBrainCardId(null);
      setSelectedHandCardId(null);

      return {
        animationSequence,
        brainCardIds: brain.map((card) => card.id),
        ejectedCardId: ejectedCard.id,
        forcedCardId: insertedCard.id,
        insertedCardId: insertedCard.id,
      };
    },
    [zones],
  );

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

  const presentReply = useCallback((activatedCardIds: string[]) => {
    setZones((current) => {
      const brainCardIds = new Set(current.brain.map((card) => card.id));
      return {
        ...current,
        activatedCardIds: activatedCardIds
          .filter((id) => brainCardIds.has(id))
          .slice(0, 2),
      };
    });
  }, []);

  const clearReplyPresentation = useCallback(() => {
    setZones((current) => ({ ...current, activatedCardIds: [] }));
  }, []);

  const acceptReply = useCallback((activatedCardIds: string[]) => {
    setZones((current) => {
      return {
        ...current,
        remainingInterferenceCount: MAX_INTERFERENCE_COUNT,
        activatedCardIds: current.activatedCardIds.filter((id) =>
          activatedCardIds.includes(id),
        ),
        forcedCardId: null,
      };
    });
  }, []);

  return {
    maxInterferenceCount: MAX_INTERFERENCE_COUNT,
    acceptReply,
    beginReply,
    clearReplyPresentation,
    presentReply,
    resetTurn,
    selectCard,
    selectedBrainCardId,
    selectedHandCardId,
    swapCards,
    zones,
  };
}

export type CardGamePrototypeController = ReturnType<
  typeof useCardGamePrototype
>;
