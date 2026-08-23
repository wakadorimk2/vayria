import type { AttentionState } from './attentionStateController.js';

export const ATTENTION_ENGAGEMENT_CONFIG = {
  cameraEntryPeak: 0.35,
  viewerEngagedPeak: 1,
  holdMs: 500,
  decayMs: 2_500,
  releaseMs: 250,
} as const;

export interface AttentionEngagementInput {
  state: AttentionState;
  viewerEngaged: boolean;
  hasCameraPosition: boolean;
}

export class AttentionEngagementController {
  private value = 0;
  private previousState: AttentionState = 'Idle';
  private previousViewerEngaged = false;
  private holdRemainingMs = 0;
  private decayElapsedMs = 0;
  private decayStartValue = 0;

  update(
    deltaSeconds: number,
    input: AttentionEngagementInput,
  ): number {
    const deltaMs = toDeltaMs(deltaSeconds);
    const enteredViewer =
      input.state === 'AttendViewer' && this.previousState !== 'AttendViewer';
    const viewerEngagedStarted =
      input.viewerEngaged && !this.previousViewerEngaged;

    this.previousState = input.state;
    this.previousViewerEngaged = input.viewerEngaged;

    if (input.state !== 'AttendViewer') {
      this.holdRemainingMs = 0;
      this.decayElapsedMs = 0;
      this.decayStartValue = 0;
      this.value = moveTowardZero(
        this.value,
        deltaMs,
        ATTENTION_ENGAGEMENT_CONFIG.releaseMs,
      );
      return this.value;
    }

    if (viewerEngagedStarted) {
      this.trigger(ATTENTION_ENGAGEMENT_CONFIG.viewerEngagedPeak);
    } else if (enteredViewer && input.hasCameraPosition) {
      this.trigger(ATTENTION_ENGAGEMENT_CONFIG.cameraEntryPeak);
    }

    if (this.holdRemainingMs > 0) {
      this.holdRemainingMs = Math.max(0, this.holdRemainingMs - deltaMs);
      return this.value;
    }

    if (this.decayStartValue <= 0) return 0;

    this.decayElapsedMs = Math.min(
      ATTENTION_ENGAGEMENT_CONFIG.decayMs,
      this.decayElapsedMs + deltaMs,
    );
    this.value =
      this.decayStartValue *
      (1 - this.decayElapsedMs / ATTENTION_ENGAGEMENT_CONFIG.decayMs);
    return this.value;
  }

  reset(): void {
    this.value = 0;
    this.previousState = 'Idle';
    this.previousViewerEngaged = false;
    this.holdRemainingMs = 0;
    this.decayElapsedMs = 0;
    this.decayStartValue = 0;
  }

  private trigger(peak: number): void {
    this.value = Math.max(this.value, clampLevel(peak));
    this.holdRemainingMs = ATTENTION_ENGAGEMENT_CONFIG.holdMs;
    this.decayElapsedMs = 0;
    this.decayStartValue = this.value;
  }
}

function toDeltaMs(deltaSeconds: number): number {
  if (!Number.isFinite(deltaSeconds)) return 0;
  return Math.max(0, deltaSeconds) * 1_000;
}

function moveTowardZero(
  value: number,
  deltaMs: number,
  durationMs: number,
): number {
  if (value <= 0 || durationMs <= 0) return 0;
  return Math.max(0, value * (1 - Math.min(deltaMs / durationMs, 1)));
}

function clampLevel(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, 1));
}
