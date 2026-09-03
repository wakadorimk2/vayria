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
  pointerX: number;
  pointerY: number;
  viewportWidth: number;
  viewportHeight: number;
}

export interface CardDropLabelPlacement {
  left: number;
  top: number;
}

export interface CardDropPreview {
  targetCardId: string;
  phase: 'candidate' | 'locked';
  overlapRatio: number;
  retreatY: number;
  scale: number;
  rotationDeg: number;
  labelPlacement: CardDropLabelPlacement | null;
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
const LABEL_WIDTH_PX = 148;
const LABEL_HEIGHT_PX = 28;
const LABEL_GAP_PX = 8;
const VIEWPORT_MARGIN_PX = 8;
const POINTER_EXCLUSION_RADIUS_PX = 48;

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

function intersectsPointerExclusion(
  left: number,
  top: number,
  pointerX: number,
  pointerY: number,
): boolean {
  const closestX = clamp(pointerX, left, left + LABEL_WIDTH_PX);
  const closestY = clamp(pointerY, top, top + LABEL_HEIGHT_PX);
  return (
    Math.hypot(pointerX - closestX, pointerY - closestY) <
    POINTER_EXCLUSION_RADIUS_PX
  );
}

export function resolveCardDropLabelPlacement(
  layout: CardDropPreviewLayout,
  target: CardDropPreviewCard,
  input: CardDropPreviewInput,
): CardDropLabelPlacement {
  const maximumLeft = Math.max(
    VIEWPORT_MARGIN_PX,
    input.viewportWidth - LABEL_WIDTH_PX - VIEWPORT_MARGIN_PX,
  );
  const maximumTop = Math.max(
    VIEWPORT_MARGIN_PX,
    input.viewportHeight - LABEL_HEIGHT_PX - VIEWPORT_MARGIN_PX,
  );
  const centeredLeft = clamp(
    target.centerX - LABEL_WIDTH_PX / 2,
    VIEWPORT_MARGIN_PX,
    maximumLeft,
  );
  const top = clamp(
    layout.top - LABEL_HEIGHT_PX - LABEL_GAP_PX,
    VIEWPORT_MARGIN_PX,
    maximumTop,
  );
  if (
    !intersectsPointerExclusion(
      centeredLeft,
      top,
      input.pointerX,
      input.pointerY,
    )
  ) {
    return { left: centeredLeft, top };
  }

  const horizontalOffset =
    target.width / 2 + LABEL_WIDTH_PX / 2 + LABEL_GAP_PX;
  const preferredDirection = input.pointerX <= target.centerX ? 1 : -1;
  const preferredLeft = clamp(
    target.centerX +
      preferredDirection * horizontalOffset -
      LABEL_WIDTH_PX / 2,
    VIEWPORT_MARGIN_PX,
    maximumLeft,
  );
  if (
    !intersectsPointerExclusion(
      preferredLeft,
      top,
      input.pointerX,
      input.pointerY,
    )
  ) {
    return { left: preferredLeft, top };
  }

  return {
    left: clamp(
      target.centerX -
        preferredDirection * horizontalOffset -
        LABEL_WIDTH_PX / 2,
      VIEWPORT_MARGIN_PX,
      maximumLeft,
    ),
    top,
  };
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
    labelPlacement:
      phase === 'locked'
        ? resolveCardDropLabelPlacement(layout, selected.card, input)
        : null,
  };
}
