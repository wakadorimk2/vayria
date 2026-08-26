export const ATTENTION_ENERGY_CONFIG = {
  normalBaseline: 0.25,
  cardInputImpulse: 0.12,
  cardDecayMs: 300,
  cardMaximum: 0.5,
  dragBaseline: 0.33,
  dragStartMinimum: 0.55,
  dragMaximum: 0.55,
  dragResponseMs: 400,
  dragSpeedReferencePxPerSecond: 600,
} as const;

export interface AttentionEnergySnapshot {
  readonly energy: number;
  readonly active: boolean;
}

/**
 * Tracks the short-lived attention input created by a card event.
 *
 * The controller changes output strength only. It does not select a target
 * and it does not change semantic ownership.
 */
export class AttentionEnergyController {
  private energy = 0;
  private lastUpdatedAt: number | null = null;
  private active = false;

  trigger(
    now: number,
    currentEnergy: number = ATTENTION_ENERGY_CONFIG.normalBaseline,
  ):
    AttentionEnergySnapshot {
    this.update(now);
    const startingEnergy = Math.max(
      this.energy,
      clampStrength(currentEnergy),
      ATTENTION_ENERGY_CONFIG.normalBaseline,
    );
    this.energy = clampStrength(
      Math.min(
        ATTENTION_ENERGY_CONFIG.cardMaximum,
        startingEnergy + ATTENTION_ENERGY_CONFIG.cardInputImpulse,
      ),
    );
    this.active = true;
    this.lastUpdatedAt = normalizeNow(now);
    return this.snapshot();
  }

  hold(now: number, currentEnergy: number): AttentionEnergySnapshot {
    this.update(now);
    this.energy = clampStrength(
      Math.max(currentEnergy, ATTENTION_ENERGY_CONFIG.normalBaseline),
    );
    this.active = true;
    this.lastUpdatedAt = normalizeNow(now);
    return this.snapshot();
  }

  update(now: number): AttentionEnergySnapshot {
    const timestamp = normalizeNow(now);
    if (this.lastUpdatedAt === null) {
      this.lastUpdatedAt = timestamp;
      return this.snapshot();
    }

    const deltaMs = Math.max(0, timestamp - this.lastUpdatedAt);
    this.lastUpdatedAt = timestamp;
    if (!this.active) return this.snapshot();

    this.energy = moveToward(
      this.energy,
      ATTENTION_ENERGY_CONFIG.normalBaseline,
      deltaMs,
      ATTENTION_ENERGY_CONFIG.cardDecayMs,
    );
    return this.snapshot();
  }

  snapshot(): AttentionEnergySnapshot {
    return {
      energy: this.active
        ? clampStrength(this.energy)
        : ATTENTION_ENERGY_CONFIG.normalBaseline,
      active: this.active,
    };
  }

  clear(): AttentionEnergySnapshot {
    this.energy = 0;
    this.lastUpdatedAt = null;
    this.active = false;
    return this.snapshot();
  }

  holdBaseline(now: number): AttentionEnergySnapshot {
    this.update(now);
    this.energy = ATTENTION_ENERGY_CONFIG.normalBaseline;
    this.active = true;
    this.lastUpdatedAt = normalizeNow(now);
    return this.snapshot();
  }
}

export function calculateDragEnergyTarget(
  speedPxPerSecond: number,
): number {
  const safeSpeed = Number.isFinite(speedPxPerSecond)
    ? Math.max(0, speedPxPerSecond)
    : 0;
  const speed01 = Math.min(
    safeSpeed / ATTENTION_ENERGY_CONFIG.dragSpeedReferencePxPerSecond,
    1,
  );
  return (
    ATTENTION_ENERGY_CONFIG.dragBaseline +
    (ATTENTION_ENERGY_CONFIG.dragMaximum -
      ATTENTION_ENERGY_CONFIG.dragBaseline) *
      speed01
  );
}

export function moveAttentionEnergy(
  currentEnergy: number,
  targetEnergy: number,
  deltaMs: number,
  responseMs: number,
): number {
  const current = clampStrength(currentEnergy);
  const target = clampStrength(targetEnergy);
  const safeDeltaMs = Number.isFinite(deltaMs) ? Math.max(0, deltaMs) : 0;
  const safeResponseMs = Number.isFinite(responseMs)
    ? Math.max(responseMs, 1)
    : 1;
  const alpha = 1 - Math.exp(-safeDeltaMs / safeResponseMs);
  return clampStrength(current + (target - current) * alpha);
}

function moveToward(
  current: number,
  target: number,
  deltaMs: number,
  responseMs: number,
): number {
  return moveAttentionEnergy(current, target, deltaMs, responseMs);
}

function normalizeNow(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function clampStrength(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(value, 1));
}
