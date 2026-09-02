import type { AttentionGazeOverride } from '../performer/types.js';

export type CardGazeBaseContext = 'free' | 'viewer' | 'dialogue';

export interface CardGazeOverrideWeights {
  readonly eye: number;
  readonly head: number;
  readonly neck: number;
  readonly viewerCheckIn: boolean;
}

export const CARD_GAZE_OVERRIDE_TIMING = {
  headStartMs: 250,
  headFullMs: 450,
  neckStartMs: 600,
  neckFullMs: 900,
} as const;

const CONTEXT_WEIGHTS: Record<
  CardGazeBaseContext,
  { readonly eye: number; readonly head: number; readonly neck: number }
> = {
  free: { eye: 1, head: 0.6, neck: 0.2 },
  viewer: { eye: 0.9, head: 0.45, neck: 0.15 },
  dialogue: { eye: 0.6, head: 0.25, neck: 0.08 },
};

export function getCardGazeOverrideWeights(
  gazeOverride: AttentionGazeOverride,
  context: CardGazeBaseContext,
): CardGazeOverrideWeights {
  const contextWeights = CONTEXT_WEIGHTS[context];
  const elapsedMs = finiteNonNegative(gazeOverride.elapsedMs);
  const isViewerCheckIn =
    gazeOverride.kind === 'card-drag' &&
    context !== 'free' &&
    gazeOverride.viewerCheckIn;
  const transientStrength =
    gazeOverride.kind === 'card-transient'
      ? clampLevel(gazeOverride.energy)
      : 1;

  return {
    eye: isViewerCheckIn
      ? 0
      : contextWeights.eye * transientStrength,
    head:
      contextWeights.head *
      smoothstep(
        CARD_GAZE_OVERRIDE_TIMING.headStartMs,
        CARD_GAZE_OVERRIDE_TIMING.headFullMs,
        elapsedMs,
      ),
    neck:
      contextWeights.neck *
      smoothstep(
        CARD_GAZE_OVERRIDE_TIMING.neckStartMs,
        CARD_GAZE_OVERRIDE_TIMING.neckFullMs,
        elapsedMs,
      ),
    viewerCheckIn: isViewerCheckIn,
  };
}

function smoothstep(minimum: number, maximum: number, value: number): number {
  if (value <= minimum) return 0;
  if (value >= maximum) return 1;
  const level = (value - minimum) / (maximum - minimum);
  return level * level * (3 - 2 * level);
}

function finiteNonNegative(value: number): number {
  return Number.isFinite(value) ? Math.max(0, value) : 0;
}

function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, 1));
}
