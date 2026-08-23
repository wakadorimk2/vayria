import type { AttentionPosition } from '../performer/types.js';

export const CAMERA_ATTENTION_CONFIG = {
  candidateAcquisitionMs: 300,
  minConfidence: 0.6,
  positionDeadZone: 0.04,
  smoothingMs: 120,
  visualSmoothingMs: 220,
  minPosition: 0.15,
  maxPosition: 0.85,
  coastingMs: 300,
  uncertainEyeStartMs: 800,
  lostMs: 2_500,
  reacquireMs: 250,
  faceLossGraceMs: 2_500,
  recoverMs: 250,
  inferenceIntervalMs: 100,
} as const;

export interface FaceLandmarkPoint {
  x: number;
  y: number;
}

export function clampNormalizedPosition(
  position: AttentionPosition,
): AttentionPosition {
  return {
    x: clampFinite(position.x, 0, 1),
    y: clampFinite(position.y, 0, 1),
  };
}

export function invertHorizontalAttentionPosition(
  position: AttentionPosition,
): AttentionPosition {
  const normalized = clampNormalizedPosition(position);
  return {
    x: 1 - normalized.x,
    y: normalized.y,
  };
}

export function clampAttentionPosition(
  position: AttentionPosition,
): AttentionPosition {
  return {
    x: clampFinite(
      position.x,
      CAMERA_ATTENTION_CONFIG.minPosition,
      CAMERA_ATTENTION_CONFIG.maxPosition,
    ),
    y: clampFinite(
      position.y,
      CAMERA_ATTENTION_CONFIG.minPosition,
      CAMERA_ATTENTION_CONFIG.maxPosition,
    ),
  };
}

export function normalizeFaceBounds(
  landmarks: readonly FaceLandmarkPoint[],
): AttentionPosition | null {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  let hasValidPoint = false;

  for (const landmark of landmarks) {
    if (!Number.isFinite(landmark.x) || !Number.isFinite(landmark.y)) {
      continue;
    }

    const x = clampFinite(landmark.x, 0, 1);
    const y = clampFinite(landmark.y, 0, 1);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
    hasValidPoint = true;
  }

  if (!hasValidPoint) return null;

  return {
    x: (minX + maxX) / 2,
    y: (minY + maxY) / 2,
  };
}

export function applyPositionDeadZone(
  next: AttentionPosition,
  previous: AttentionPosition | null,
  deadZone = CAMERA_ATTENTION_CONFIG.positionDeadZone,
): AttentionPosition {
  const clampedNext = clampAttentionPosition(next);
  if (!previous) return clampedNext;

  const clampedPrevious = clampAttentionPosition(previous);
  return {
    x:
      Math.abs(clampedNext.x - clampedPrevious.x) < deadZone
        ? clampedPrevious.x
        : clampedNext.x,
    y:
      Math.abs(clampedNext.y - clampedPrevious.y) < deadZone
        ? clampedPrevious.y
        : clampedNext.y,
  };
}

export function smoothAttentionPosition(
  current: AttentionPosition | null,
  target: AttentionPosition,
  deltaMs: number,
  smoothingMs: number = CAMERA_ATTENTION_CONFIG.smoothingMs,
): AttentionPosition {
  const clampedTarget = clampAttentionPosition(target);
  if (!current) return clampedTarget;
  if (smoothingMs <= 0 || deltaMs <= 0) {
    return clampAttentionPosition(current);
  }

  const safeDeltaMs = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0;
  const alpha = 1 - Math.exp(-safeDeltaMs / smoothingMs);
  const clampedCurrent = clampAttentionPosition(current);
  return clampAttentionPosition({
    x: clampedCurrent.x + (clampedTarget.x - clampedCurrent.x) * alpha,
    y: clampedCurrent.y + (clampedTarget.y - clampedCurrent.y) * alpha,
  });
}

export function lerpAttentionPosition(
  from: AttentionPosition,
  to: AttentionPosition,
  progress: number,
): AttentionPosition {
  const safeProgress = clampUnit(progress);
  const clampedFrom = clampAttentionPosition(from);
  const clampedTo = clampAttentionPosition(to);
  return clampAttentionPosition({
    x: clampedFrom.x + (clampedTo.x - clampedFrom.x) * safeProgress,
    y: clampedFrom.y + (clampedTo.y - clampedFrom.y) * safeProgress,
  });
}

export function getUncertainEyePosition(
  position: AttentionPosition,
  missingMs: number,
): AttentionPosition {
  const safeMissingMs = Number.isFinite(missingMs)
    ? Math.max(0, missingMs)
    : CAMERA_ATTENTION_CONFIG.lostMs;
  if (safeMissingMs <= CAMERA_ATTENTION_CONFIG.uncertainEyeStartMs) {
    return clampAttentionPosition(position);
  }

  const durationMs =
    CAMERA_ATTENTION_CONFIG.lostMs -
    CAMERA_ATTENTION_CONFIG.uncertainEyeStartMs;
  const progress = smoothstep(
    (safeMissingMs - CAMERA_ATTENTION_CONFIG.uncertainEyeStartMs) /
      Math.max(durationMs, 1),
  );
  return lerpAttentionPosition(position, getAttentionCenter(), progress);
}

export function getCameraAttentionConfidence(missingMs: number): number {
  const safeMissingMs = Number.isFinite(missingMs)
    ? Math.max(0, missingMs)
    : CAMERA_ATTENTION_CONFIG.lostMs;
  if (safeMissingMs <= CAMERA_ATTENTION_CONFIG.coastingMs) return 1;
  if (safeMissingMs >= CAMERA_ATTENTION_CONFIG.lostMs) return 0;

  const progress = smoothstep(
    (safeMissingMs - CAMERA_ATTENTION_CONFIG.coastingMs) /
      Math.max(
        CAMERA_ATTENTION_CONFIG.lostMs -
          CAMERA_ATTENTION_CONFIG.coastingMs,
        1,
      ),
  );
  return 1 - progress;
}

export function getReengagingConfidence(elapsedMs: number): number {
  const safeElapsedMs = Number.isFinite(elapsedMs)
    ? Math.max(0, elapsedMs)
    : 0;
  const progress = smoothstep(
    safeElapsedMs / Math.max(CAMERA_ATTENTION_CONFIG.reacquireMs, 1),
  );
  return 0.25 + 0.75 * progress;
}

export function isUsableCameraAttention(
  position: AttentionPosition | null,
  confidence: number,
  minimumConfidence = CAMERA_ATTENTION_CONFIG.minConfidence,
): position is AttentionPosition {
  return (
    position !== null &&
    Number.isFinite(position.x) &&
    Number.isFinite(position.y) &&
    Number.isFinite(confidence) &&
    confidence >= minimumConfidence
  );
}

function clampFinite(value: number, minimum: number, maximum: number): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(value, maximum));
}

function getAttentionCenter(): AttentionPosition {
  return { x: 0.5, y: 0.5 };
}

function clampUnit(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, 1));
}

function smoothstep(value: number): number {
  const clamped = clampUnit(value);
  return clamped * clamped * (3 - 2 * clamped);
}
