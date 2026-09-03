export interface CardDropPreviewCard {
  id: string;
  centerX: number;
  centerY: number;
  width: number;
  height: number;
}

export interface CardDropPreviewLayout {
  left: number;
  right: number;
  top: number;
  bottom: number;
  cards: readonly CardDropPreviewCard[];
}

export interface CardDropPreviewInput {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CardDropPreview {
  targetCardId: string;
  phase: 'candidate' | 'locked';
  overlapRatio: number;
  retreatY: number;
  scale: number;
  rotationDeg: number;
}

export function resolveCommittedCardDropTarget(
  displayedPreview: CardDropPreview | null,
  finalPreview: CardDropPreview | null,
): string | null {
  if (
    displayedPreview?.phase !== 'locked' ||
    finalPreview?.phase !== 'locked' ||
    finalPreview.targetCardId !== displayedPreview.targetCardId
  ) {
    return null;
  }
  return displayedPreview.targetCardId;
}

const LOCK_OVERLAP_RATIO = 0.35;
const UNLOCK_OVERLAP_RATIO = 0.2;
const RETARGET_ADVANTAGE_RATIO = 0.15;
const RETREAT_HEIGHT_RATIO = 0.24;
const MIN_RETREAT_PX = 24;
const MAX_RETREAT_PX = 40;

interface ScoredCard {
  card: CardDropPreviewCard;
  overlapRatio: number;
}

interface Rect {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function asRect(input: CardDropPreviewInput): Rect {
  return {
    left: input.left,
    right: input.left + input.width,
    top: input.top,
    bottom: input.top + input.height,
  };
}

function cardRect(card: CardDropPreviewCard): Rect {
  return {
    left: card.centerX - card.width / 2,
    right: card.centerX + card.width / 2,
    top: card.centerY - card.height / 2,
    bottom: card.centerY + card.height / 2,
  };
}

export function measureCardOverlapRatio(
  card: CardDropPreviewCard,
  draggedRect: Rect,
): number {
  const targetRect = cardRect(card);
  const overlapWidth = Math.max(
    0,
    Math.min(targetRect.right, draggedRect.right) -
      Math.max(targetRect.left, draggedRect.left),
  );
  const overlapHeight = Math.max(
    0,
    Math.min(targetRect.bottom, draggedRect.bottom) -
      Math.max(targetRect.top, draggedRect.top),
  );
  return (overlapWidth * overlapHeight) / Math.max(card.width * card.height, 1);
}

function scoreCards(
  layout: CardDropPreviewLayout,
  draggedRect: Rect,
): ScoredCard[] {
  return layout.cards
    .map((card) => ({
      card,
      overlapRatio: measureCardOverlapRatio(card, draggedRect),
    }))
    .sort((left, right) => right.overlapRatio - left.overlapRatio);
}

export function resolveCardDropPreview(
  layout: CardDropPreviewLayout | null,
  input: CardDropPreviewInput,
  lockedTargetCardId: string | null = null,
): CardDropPreview | null {
  if (!layout || !layout.cards.length) return null;

  const scoredCards = scoreCards(layout, asRect(input));
  const best = scoredCards[0];
  if (!best || best.overlapRatio <= 0) return null;

  const locked = lockedTargetCardId
    ? scoredCards.find(({ card }) => card.id === lockedTargetCardId) ?? null
    : null;
  let selected = best;
  let phase: CardDropPreview['phase'] =
    best.overlapRatio >= LOCK_OVERLAP_RATIO ? 'locked' : 'candidate';

  if (locked && locked.overlapRatio >= UNLOCK_OVERLAP_RATIO) {
    const challengerCanRetarget =
      best.card.id !== locked.card.id &&
      best.overlapRatio >= LOCK_OVERLAP_RATIO &&
      best.overlapRatio >=
        locked.overlapRatio + RETARGET_ADVANTAGE_RATIO;
    selected = challengerCanRetarget ? best : locked;
    phase = 'locked';
  }

  const retreatY =
    phase === 'locked'
      ? -clamp(
          selected.card.height * RETREAT_HEIGHT_RATIO,
          MIN_RETREAT_PX,
          MAX_RETREAT_PX,
        )
      : 0;
  const rotationDeg =
    phase === 'locked'
      ? selected.card.centerX < (layout.left + layout.right) / 2
        ? -2
        : 2
      : 0;

  return {
    targetCardId: selected.card.id,
    phase,
    overlapRatio: selected.overlapRatio,
    retreatY,
    scale: phase === 'locked' ? 0.94 : 1,
    rotationDeg,
  };
}
