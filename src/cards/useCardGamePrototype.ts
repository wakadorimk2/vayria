import { useCallback, useRef, useState } from 'react';
import { cardPool } from './cardPool';
import { M1_INITIAL_BRAIN_CARD_IDS } from './cardReactions';
import type { WildcardCardData } from './cardTypes';
import { acceptCardReply } from './cardReplyState';
import { chooseSlotCard } from './slotCardInsertion';

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
  swapRevision: number;
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

function createInitialState(worldEnabled = false): CardZoneState {
  return {
    swapRevision: 0,
    brain: selectCards(M1_INITIAL_BRAIN_CARD_IDS),
    hand: selectCards(INITIAL_HAND_IDS.map(id => worldEnabled && id === 'panic' ? 'underwater' : id)),
    remainingInterferenceCount: MAX_INTERFERENCE_COUNT,
    activatedCardIds: [],
    forcedCardId: null,
  };
}

export function useCardGamePrototype(unlimitedInterference = false, worldEnabled = false) {
  const [zones, setZones] = useState<CardZoneState>(() => createInitialState(worldEnabled));
  const zonesRef = useRef(zones);
  const updateZones = useCallback((update: (current: CardZoneState) => CardZoneState) => {
    zonesRef.current = update(zonesRef.current);
    setZones(zonesRef.current);
  }, []);
  const readCardContext = useCallback(() => ({
    brainCardIds: zonesRef.current.brain.map(card => card.id),
    forcedCardId: zonesRef.current.forcedCardId,
    swapRevision: zonesRef.current.swapRevision,
  }), []);
  const swapSequenceRef = useRef(0);
  const reinforcementRef = useRef<Record<string, number>>({});
  const insertSlotCard = useCallback((cardId: string): CardSwapResult | null => {
    const current = zonesRef.current;
    const choice = chooseSlotCard(current.brain, cardId, reinforcementRef.current);
    if (!choice) return null;
    const sequence = ++swapSequenceRef.current;
    reinforcementRef.current[cardId] = sequence;
    const hand = current.hand.filter(c => c.id !== cardId);
    if (!choice.reinforced && !hand.some(c => c.id === choice.ejected.id)) hand.push(choice.ejected);
    updateZones(() => ({ ...current, brain: choice.brain, hand: hand.slice(-5), swapRevision: sequence, forcedCardId: cardId, activatedCardIds: [], remainingInterferenceCount: MAX_INTERFERENCE_COUNT }));
    return { animationSequence: sequence, brainCardIds: choice.brain.map(c => c.id), ejectedCardId: choice.ejected.id, forcedCardId: cardId, insertedCardId: cardId };
  }, [updateZones]);
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
      const zones = zonesRef.current;
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
      updateZones((current) => {
        if (current.remainingInterferenceCount === 0) return current;

        return {
          swapRevision: animationSequence,
          brain,
          hand,
          remainingInterferenceCount: unlimitedInterference ? MAX_INTERFERENCE_COUNT : 0,
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
    [updateZones, unlimitedInterference],
  );

  const resetTurn = useCallback(() => {
    updateZones((current) => ({
      ...current,
      remainingInterferenceCount: MAX_INTERFERENCE_COUNT,
      activatedCardIds: [],
      forcedCardId: null,
    }));
    setSelectedBrainCardId(null);
    setSelectedHandCardId(null);
  }, [updateZones]);

  const resetGame = useCallback(() => {
    reinforcementRef.current = {};
    updateZones(() => ({ ...createInitialState(worldEnabled), swapRevision: ++swapSequenceRef.current }));
    setSelectedBrainCardId(null);
    setSelectedHandCardId(null);
  }, [worldEnabled, updateZones]);

  const resetCards = useCallback(() => {
    updateZones(() => ({ ...createInitialState(), swapRevision: ++swapSequenceRef.current }));
    setSelectedBrainCardId(null);
    setSelectedHandCardId(null);
  }, [updateZones]);

  const beginReply = useCallback(() => {
    updateZones((current) => ({ ...current, activatedCardIds: [] }));
  }, [updateZones]);

  const presentReply = useCallback((activatedCardIds: string[]) => {
    updateZones((current) => {
      const brainCardIds = new Set(current.brain.map((card) => card.id));
      return {
        ...current,
        activatedCardIds: activatedCardIds
          .filter((id) => brainCardIds.has(id))
          .slice(0, 2),
      };
    });
  }, [updateZones]);

  const clearReplyPresentation = useCallback(() => {
    updateZones((current) => ({ ...current, activatedCardIds: [] }));
  }, [updateZones]);

  const acceptReply = useCallback((activatedCardIds: string[], swapRevision?: number) => {
    updateZones(current => acceptCardReply(current, activatedCardIds, swapRevision, MAX_INTERFERENCE_COUNT));
  }, [updateZones]);

  return {
    insertSlotCard,
    readCardContext,
    maxInterferenceCount: MAX_INTERFERENCE_COUNT,
    acceptReply,
    beginReply,
    clearReplyPresentation,
    presentReply,
    resetTurn,
    resetGame,
    resetCards,
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
