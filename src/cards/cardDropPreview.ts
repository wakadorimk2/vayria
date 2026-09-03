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

export interface CardDropPreview {
  targetCardId: string;
  progress: number;
  retreatX: number;
  retreatY: number;
}

const DROP_TARGET_MARGIN_PX = 16;
const MAX_RETREAT_HEIGHT_RATIO = 0.55;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function resolveCardDropPreview(
  layout: CardDropPreviewLayout | null,
  draggedCenter: { x: number; y: number },
): CardDropPreview | null {
  if (!layout || !layout.cards.length) return null;
  if (
    draggedCenter.x < layout.left - DROP_TARGET_MARGIN_PX ||
    draggedCenter.x > layout.right + DROP_TARGET_MARGIN_PX ||
    draggedCenter.y < layout.top - DROP_TARGET_MARGIN_PX ||
    draggedCenter.y > layout.bottom + DROP_TARGET_MARGIN_PX
  ) {
    return null;
  }

  const target = layout.cards.reduce((nearest, card) =>
    Math.abs(card.centerX - draggedCenter.x) <
    Math.abs(nearest.centerX - draggedCenter.x)
      ? card
      : nearest,
  );
  const deltaX = target.centerX - draggedCenter.x;
  const deltaY = target.centerY - draggedCenter.y;
  const normalizedDistance = Math.hypot(
    deltaX / Math.max(target.width, 1),
    deltaY / Math.max(target.height, 1),
  );
  const progress = clamp01(1 - normalizedDistance);
  const directionLength = Math.hypot(deltaX, deltaY);
  const directionX = directionLength > 0.001 ? deltaX / directionLength : 0;
  const directionY = directionLength > 0.001 ? deltaY / directionLength : -1;
  const retreat = target.height * MAX_RETREAT_HEIGHT_RATIO * progress;

  return {
    targetCardId: target.id,
    progress,
    retreatX: directionX * retreat,
    retreatY: directionY * retreat,
  };
}
