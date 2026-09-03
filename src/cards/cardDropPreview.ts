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
  dragTop: number;
  dragBottom: number;
}

export interface CardDropPreview {
  targetCardId: string;
  phase: 'candidate' | 'locked';
  retreatY: number;
  scale: number;
  rotationDeg: number;
}

export interface CardDragPlacementInput {
  pointerX: number;
  pointerY: number;
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
    displayedPreview?.phase !== 'locked' ||
    finalPreview?.phase !== 'locked' ||
    finalPreview.targetCardId !== displayedPreview.targetCardId
  ) {
    return null;
  }
  return displayedPreview.targetCardId;
}

const CANDIDATE_APPROACH_PX = 24;
const LOCK_OVERLAP_PX = 12;
const UNLOCK_OVERLAP_PX = 8;
const RETARGET_HYSTERESIS_RATIO = 0.15;
const CANDIDATE_CONTACT_RETREAT_PX = 4;
const CANDIDATE_MAX_RETREAT_PX = 28;
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

function resolveCandidateRetreat(gap: number, overlap: number): number {
  if (overlap <= 0) {
    const approachProgress = clamp(
      1 - gap / CANDIDATE_APPROACH_PX,
      0,
      1,
    );
    return CANDIDATE_CONTACT_RETREAT_PX * approachProgress;
  }
  const insertionProgress = clamp(overlap / LOCK_OVERLAP_PX, 0, 1);
  return (
    CANDIDATE_CONTACT_RETREAT_PX +
    (CANDIDATE_MAX_RETREAT_PX - CANDIDATE_CONTACT_RETREAT_PX) *
      insertionProgress
  );
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
  previousPreview: CardDropPreview | null = null,
): CardDropPreview | null {
  if (!layout || !layout.cards.length) return null;

  const previousTarget = previousPreview
    ? layout.cards.find((card) => card.id === previousPreview.targetCardId) ?? null
    : null;
  const overlap = Math.max(
    0,
    Math.min(layout.bottom, input.dragBottom) -
      Math.max(layout.top, input.dragTop),
  );
  const gap =
    input.dragBottom < layout.top
      ? layout.top - input.dragBottom
      : input.dragTop > layout.bottom
        ? input.dragTop - layout.bottom
        : 0;
  const phase: CardDropPreview['phase'] =
    previousPreview?.phase === 'locked' && overlap >= UNLOCK_OVERLAP_PX
      ? 'locked'
      : overlap >= LOCK_OVERLAP_PX
        ? 'locked'
        : 'candidate';
  if (phase === 'candidate' && gap > CANDIDATE_APPROACH_PX) return null;

  const nearest = findNearestCard(layout.cards, input.pointerX);
  if (!nearest) return null;
  const selected =
    previousTarget &&
    nearest.id !== previousTarget.id &&
    !canRetarget(previousTarget, nearest, input.pointerX)
      ? previousTarget
      : nearest;
  const candidateRetreat = resolveCandidateRetreat(gap, overlap);
  const retreatY =
    phase === 'locked'
      ? -clamp(
          selected.height * RETREAT_HEIGHT_RATIO,
          MIN_RETREAT_PX,
          MAX_RETREAT_PX,
        )
      : candidateRetreat === 0
        ? 0
        : -candidateRetreat;
  const rotationDeg =
    phase === 'locked'
      ? selected.centerX < (layout.left + layout.right) / 2
        ? -2
        : 2
      : 0;

  return {
    targetCardId: selected.id,
    phase,
    retreatY,
    scale: phase === 'locked' ? 0.94 : 1,
    rotationDeg,
  };
}
