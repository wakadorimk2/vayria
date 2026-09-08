/** Detect sustained face presence, not identity or a count of visitors. */
export class ViewerArrivalController {
  private visibleSince: number | null = null;
  private absentSince: number | null = null;
  private announced = false;
  private noticedAt: number | null = null;
  private lastArrivalAt = -Infinity;

  /** A real viewer interaction consumes the welcome for this visit. */
  consumeGreeting(): void { this.announced = true; }

  /** Pausing observation must not invent a departure or accumulate dwell time. */
  pause(): void {
    this.visibleSince = null;
    this.absentSince = null;
  }

  update(now: number, visible: boolean, canSpeak: boolean, canNotice = true): 'notice' | 'arrival' | 'departure' | null {
    if (!visible) {
      this.visibleSince = null;
      this.absentSince ??= now;
      if (now - this.absentSince >= 8_000 && (this.announced || this.noticedAt !== null)) {
        this.announced = false;
        this.noticedAt = null;
        return 'departure';
      }
      return null;
    }
    this.absentSince = null;
    this.visibleSince ??= now;
    if (this.noticedAt === null && canNotice && now - this.visibleSince >= 600) {
      this.noticedAt = now;
      return 'notice';
    }
    if (!this.announced && canSpeak && now - this.visibleSince >= 1_000 &&
      this.noticedAt !== null && now - this.noticedAt >= 850 &&
      now - this.lastArrivalAt >= 45_000) {
      this.announced = true;
      this.lastArrivalAt = now;
      return 'arrival';
    }
    return null;
  }
}

export function hasFreshViewerFace(
  snapshot: { position: unknown; confidence: number; updatedAt: number },
  now: number,
): boolean {
  return snapshot.position != null && Number.isFinite(snapshot.confidence) && snapshot.confidence >= 0.7 &&
    snapshot.updatedAt > 0 && now >= snapshot.updatedAt && now - snapshot.updatedAt <= 1_000;
}
