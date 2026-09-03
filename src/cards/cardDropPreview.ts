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
  pointerX: number;
  pointerY: number;
}

export interface CardDropPreview {
  targetCardId: string;
  retreatY: number;
  scale: number;
  rotationDeg: number;
}

export interface CardDragPlacementInput extends CardDropPreviewInput {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

export interface CardDragPlacement {
  left: number;
  top: number;
  centerX: number;
  centerY: number;
}

export function resolveCommittedCardDropTarget(
  displayedPreview: CardDropPreview | null,
  finalPreview: CardDropPreview | null,
): string | null {
  if (
    !displayedPreview ||
    !finalPreview ||
    finalPreview.targetCardId !== displayedPreview.targetCardId
  ) {
    return null;
  }
  return displayedPreview.targetCardId;
}

const VERTICAL_EXIT_MARGIN_PX = 24;
const RETARGET_HYSTERESIS_RATIO = 0.15;
const RETREAT_HEIGHT_RATIO = 0.6;
const MIN_RETREAT_PX = 60;
const MAX_RETREAT_PX = 100;
export const CARD_DRAG_VISUAL_LIFT_PX = 32;

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function findNearestCard(
  cards: readonly CardDropPreviewCard[],
  pointerX: number,
): CardDropPreviewCard | null {
  let nearest: CardDropPreviewCard | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;
  for (const card of cards) {
    const distance = Math.abs(pointerX - card.centerX);
    if (distance < nearestDistance) {
      nearest = card;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function canRetarget(
  locked: CardDropPreviewCard,
  challenger: CardDropPreviewCard,
  pointerX: number,
): boolean {
  const direction = Math.sign(challenger.centerX - locked.centerX);
  if (direction === 0) return false;
  const centerDistance = Math.abs(challenger.centerX - locked.centerX);
  const midpoint = (challenger.centerX + locked.centerX) / 2;
  const threshold =
    midpoint + direction * centerDistance * RETARGET_HYSTERESIS_RATIO;
  return direction > 0 ? pointerX >= threshold : pointerX <= threshold;
}

export function resolveCardDragPlacement(
  input: CardDragPlacementInput,
): CardDragPlacement {
  const left = input.pointerX - input.offsetX;
  const top = input.pointerY - input.offsetY - CARD_DRAG_VISUAL_LIFT_PX;
  return {
    left,
    top,
    centerX: left + input.width / 2,
    centerY: top + input.height / 2,
  };
}

export function resolveCardDropPreview(
  layout: CardDropPreviewLayout | null,
  input: CardDropPreviewInput,
  lockedTargetCardId: string | null = null,
): CardDropPreview | null {
  if (!layout || !layout.cards.length) return null;

  const locked = lockedTargetCardId
    ? layout.cards.find((card) => card.id === lockedTargetCardId) ?? null
    : null;
  const verticalMargin = locked ? VERTICAL_EXIT_MARGIN_PX : 0;
  if (
    input.pointerY < layout.top - verticalMargin ||
    input.pointerY > layout.bottom + verticalMargin
  ) {
    return null;
  }

  const nearest = findNearestCard(layout.cards, input.pointerX);
  if (!nearest) return null;
  const selected =
    locked && nearest.id !== locked.id && !canRetarget(locked, nearest, input.pointerX)
      ? locked
      : nearest;
  const retreatY = -clamp(
    selected.height * RETREAT_HEIGHT_RATIO,
    MIN_RETREAT_PX,
    MAX_RETREAT_PX,
  );
  const rotationDeg =
    selected.centerX < (layout.left + layout.right) / 2 ? -2 : 2;

  return {
    targetCardId: selected.id,
    retreatY,
    scale: 0.94,
    rotationDeg,
  };
}
