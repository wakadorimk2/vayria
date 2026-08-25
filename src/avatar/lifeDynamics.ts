export type RandomSource = () => number;

export const LIFE_DYNAMICS_PROFILE_IDS = [
  'baseline',
  '0.75x',
  '0.9x',
  '1.0x',
  '1.1x',
  '1.25x',
] as const;

export type LifeDynamicsProfileId =
  (typeof LIFE_DYNAMICS_PROFILE_IDS)[number];

export const LIFE_DYNAMICS_BASELINE = {
  maxDeltaSeconds: 0.1,
  breathingPeriodSeconds: 4.8,
  swayPeriodSeconds: 7.3,
  gazeApproachSeconds: 0.18,
  gazeReturnSeconds: 0.25,
  headLagSeconds: 0.08,
  torsoLagSeconds: 0.25,
  signalRiseSeconds: 0.4,
  signalDecaySeconds: 1.8,
  noiseStepPerSecond: 0.12,
  noiseReturnPerSecond: 0.5,
  initialBlinkIntervalSeconds: [1.2, 3.5] as const,
  blinkIntervalSeconds: [2.8, 6.5] as const,
  blinkCloseSeconds: 0.075,
  blinkHoldSeconds: 0.04,
  blinkOpenSeconds: 0.13,
  blinkAttentionHazardBoost: 0.5,
  gestureOnsetSeconds: 0.18,
  gestureSustainSeconds: 0.6,
  gestureDecaySeconds: 0.25,
} as const;

export interface LifeDynamicsProfile {
  readonly id: LifeDynamicsProfileId;
  readonly durationScale: number;
  readonly maxDeltaSeconds: number;
  readonly breathingPeriodSeconds: number;
  readonly swayPeriodSeconds: number;
  readonly gazeApproachSeconds: number;
  readonly gazeReturnSeconds: number;
  readonly headLagSeconds: number;
  readonly torsoLagSeconds: number;
  readonly signalRiseSeconds: number;
  readonly signalDecaySeconds: number;
  readonly noiseStepPerSecond: number;
  readonly noiseReturnPerSecond: number;
  readonly initialBlinkIntervalSeconds: readonly [number, number];
  readonly blinkIntervalSeconds: readonly [number, number];
  readonly blinkCloseSeconds: number;
  readonly blinkHoldSeconds: number;
  readonly blinkOpenSeconds: number;
  readonly blinkAttentionHazardBoost: number;
  readonly gestureOnsetSeconds: number;
  readonly gestureSustainSeconds: number;
  readonly gestureDecaySeconds: number;
}

export interface LifeDynamicsInputs {
  readonly arousal: number;
  readonly curiosity: number;
  readonly attention: Readonly<Record<string, number>>;
  readonly attentionTarget: string | null;
  readonly speechUrge: number;
  readonly inhibition: number;
  readonly energy: number;
  readonly emotion: string;
  readonly intent: string | null;
  readonly gestureIntent: string | null;
  readonly gestureTrigger: boolean;
}

export type BlinkPhase = 'waiting' | 'closing' | 'holding' | 'opening';
export type OrientingPhase =
  | 'neutral'
  | 'approaching'
  | 'holding'
  | 'returning';
export type GesturePhase = 'idle' | 'onset' | 'sustain' | 'decay';

export interface LifeDynamicsSnapshot {
  readonly profileId: LifeDynamicsProfileId;
  readonly signals: Readonly<{
    arousal: number;
    curiosity: number;
    attention: Readonly<Record<string, number>>;
    speechUrge: number;
    inhibition: number;
  }>;
  readonly modulation: Readonly<{
    energy: number;
    emotion: string;
    intent: string | null;
  }>;
  readonly life: Readonly<{
    breathingPhase: number;
    swayPhase: number;
    noise: number;
  }>;
  readonly blink: Readonly<{
    state: 'waiting' | 'blinking';
    phase: BlinkPhase;
    weight: number;
  }>;
  readonly orienting: Readonly<{
    target: string | null;
    phase: OrientingPhase;
    transitionProgress: number;
    eyeWeight: number;
    headWeight: number;
    torsoWeight: number;
  }>;
  readonly gesture: Readonly<{
    intent: string | null;
    phase: GesturePhase;
    progress: number;
    weight: number;
  }>;
}

interface NormalizedInputs {
  arousal: number;
  curiosity: number;
  attention: Record<string, number>;
  attentionTarget: string | null;
  speechUrge: number;
  inhibition: number;
  energy: number;
  emotion: string;
  intent: string | null;
  gestureIntent: string | null;
  gestureTrigger: boolean;
}

interface SignalState {
  arousal: number;
  curiosity: number;
  attention: Map<string, number>;
  speechUrge: number;
  inhibition: number;
}

const PROFILE_SCALE_BY_ID: Record<LifeDynamicsProfileId, number> = {
  baseline: 1,
  '0.75x': 0.75,
  '0.9x': 0.9,
  '1.0x': 1,
  '1.1x': 1.1,
  '1.25x': 1.25,
};

export function resolveLifeDynamicsProfileId(
  value: string | null | undefined,
): LifeDynamicsProfileId {
  if (
    value &&
    (LIFE_DYNAMICS_PROFILE_IDS as readonly string[]).includes(value)
  ) {
    return value as LifeDynamicsProfileId;
  }
  return '1.0x';
}

export function createLifeDynamicsProfile(
  value: string | null | undefined,
): LifeDynamicsProfile {
  const id = resolveLifeDynamicsProfileId(value);
  const durationScale = PROFILE_SCALE_BY_ID[id];
  const scaleDuration = (seconds: number): number =>
    seconds * durationScale;
  const profile: LifeDynamicsProfile = {
    id,
    durationScale,
    maxDeltaSeconds: LIFE_DYNAMICS_BASELINE.maxDeltaSeconds,
    breathingPeriodSeconds: scaleDuration(
      LIFE_DYNAMICS_BASELINE.breathingPeriodSeconds,
    ),
    swayPeriodSeconds: scaleDuration(
      LIFE_DYNAMICS_BASELINE.swayPeriodSeconds,
    ),
    gazeApproachSeconds: scaleDuration(
      LIFE_DYNAMICS_BASELINE.gazeApproachSeconds,
    ),
    gazeReturnSeconds: scaleDuration(
      LIFE_DYNAMICS_BASELINE.gazeReturnSeconds,
    ),
    headLagSeconds: scaleDuration(LIFE_DYNAMICS_BASELINE.headLagSeconds),
    torsoLagSeconds: scaleDuration(LIFE_DYNAMICS_BASELINE.torsoLagSeconds),
    signalRiseSeconds: scaleDuration(
      LIFE_DYNAMICS_BASELINE.signalRiseSeconds,
    ),
    signalDecaySeconds: scaleDuration(
      LIFE_DYNAMICS_BASELINE.signalDecaySeconds,
    ),
    noiseStepPerSecond: LIFE_DYNAMICS_BASELINE.noiseStepPerSecond,
    noiseReturnPerSecond: LIFE_DYNAMICS_BASELINE.noiseReturnPerSecond,
    initialBlinkIntervalSeconds: scaleRange(
      LIFE_DYNAMICS_BASELINE.initialBlinkIntervalSeconds,
      durationScale,
    ),
    blinkIntervalSeconds: scaleRange(
      LIFE_DYNAMICS_BASELINE.blinkIntervalSeconds,
      durationScale,
    ),
    blinkCloseSeconds: scaleDuration(LIFE_DYNAMICS_BASELINE.blinkCloseSeconds),
    blinkHoldSeconds: scaleDuration(LIFE_DYNAMICS_BASELINE.blinkHoldSeconds),
    blinkOpenSeconds: scaleDuration(LIFE_DYNAMICS_BASELINE.blinkOpenSeconds),
    blinkAttentionHazardBoost:
      LIFE_DYNAMICS_BASELINE.blinkAttentionHazardBoost,
    gestureOnsetSeconds: scaleDuration(
      LIFE_DYNAMICS_BASELINE.gestureOnsetSeconds,
    ),
    gestureSustainSeconds: scaleDuration(
      LIFE_DYNAMICS_BASELINE.gestureSustainSeconds,
    ),
    gestureDecaySeconds: scaleDuration(
      LIFE_DYNAMICS_BASELINE.gestureDecaySeconds,
    ),
  };

  return Object.freeze(profile);
}

export class LifeDynamics {
  private readonly signals: SignalState = {
    arousal: 0,
    curiosity: 0,
    attention: new Map(),
    speechUrge: 0,
    inhibition: 0,
  };

  private breathingPhase = 0;
  private swayPhase = 0;
  private noise = 0;
  private blinkPhase: BlinkPhase = 'waiting';
  private blinkElapsedSeconds = 0;
  private blinkWaitSeconds = 0;
  private blinkHazardBoost = 0;
  private orientingTarget: string | null = null;
  private orientingPhase: OrientingPhase = 'neutral';
  private orientingElapsedSeconds = 0;
  private orientingStrength = 0;
  private gestureIntent: string | null = null;
  private gesturePhase: GesturePhase = 'idle';
  private gestureElapsedSeconds = 0;
  private previousGestureTrigger = false;

  constructor(
    private readonly profile: LifeDynamicsProfile =
      createLifeDynamicsProfile('1.0x'),
  ) {
    this.reset(() => 0.5);
  }

  get profileId(): LifeDynamicsProfileId {
    return this.profile.id;
  }

  update(
    deltaSeconds: number,
    inputs: LifeDynamicsInputs,
    random: RandomSource,
  ): LifeDynamicsSnapshot {
    const delta = clamp(
      Number.isFinite(deltaSeconds) ? deltaSeconds : 0,
      0,
      this.profile.maxDeltaSeconds,
    );
    const normalized = normalizeInputs(inputs);
    this.advanceSignals(delta, normalized);
    const targetChanged = this.advanceOrienting(delta, normalized);
    this.advanceLife(delta, random);
    this.advanceBlink(delta, random, targetChanged);
    this.advanceGesture(delta, normalized);

    return freezeSnapshot(this.createSnapshot(normalized));
  }

  reset(random: RandomSource): void {
    this.signals.arousal = 0;
    this.signals.curiosity = 0;
    this.signals.attention.clear();
    this.signals.speechUrge = 0;
    this.signals.inhibition = 0;
    this.breathingPhase = 0;
    this.swayPhase = 0;
    this.noise = 0;
    this.blinkPhase = 'waiting';
    this.blinkElapsedSeconds = 0;
    this.blinkWaitSeconds = randomBetween(
      this.profile.initialBlinkIntervalSeconds,
      random,
    );
    this.blinkHazardBoost = 0;
    this.orientingTarget = null;
    this.orientingPhase = 'neutral';
    this.orientingElapsedSeconds = 0;
    this.orientingStrength = 0;
    this.gestureIntent = null;
    this.gesturePhase = 'idle';
    this.gestureElapsedSeconds = 0;
    this.previousGestureTrigger = false;
  }

  private advanceSignals(delta: number, inputs: NormalizedInputs): void {
    this.signals.arousal = moveToward(
      this.signals.arousal,
      inputs.arousal,
      delta,
      this.profile.signalRiseSeconds,
      this.profile.signalDecaySeconds,
    );
    this.signals.curiosity = moveToward(
      this.signals.curiosity,
      inputs.curiosity,
      delta,
      this.profile.signalRiseSeconds,
      this.profile.signalDecaySeconds,
    );
    this.signals.speechUrge = moveToward(
      this.signals.speechUrge,
      inputs.speechUrge,
      delta,
      this.profile.signalRiseSeconds,
      this.profile.signalDecaySeconds,
    );
    this.signals.inhibition = moveToward(
      this.signals.inhibition,
      inputs.inhibition,
      delta,
      this.profile.signalRiseSeconds,
      this.profile.signalDecaySeconds,
    );

    const keys = new Set([
      ...this.signals.attention.keys(),
      ...Object.keys(inputs.attention),
    ]);
    for (const key of keys) {
      const current = this.signals.attention.get(key) ?? 0;
      const target = inputs.attention[key] ?? 0;
      const next = moveToward(
        current,
        target,
        delta,
        this.profile.signalRiseSeconds,
        this.profile.signalDecaySeconds,
      );
      if (next < 0.0005 && target === 0) {
        this.signals.attention.delete(key);
      } else {
        this.signals.attention.set(key, next);
      }
    }
  }

  private advanceLife(delta: number, random: RandomSource): void {
    this.breathingPhase = advancePhase(
      this.breathingPhase,
      delta,
      this.profile.breathingPeriodSeconds,
    );
    this.swayPhase = advancePhase(
      this.swayPhase,
      delta,
      this.profile.swayPeriodSeconds,
    );

    const randomValue = normalizeRandom(random());
    this.noise +=
      (randomValue * 2 - 1) * this.profile.noiseStepPerSecond * delta;
    this.noise -=
      this.noise * this.profile.noiseReturnPerSecond * delta;
    this.noise = clamp(this.noise, -1, 1);
  }

  private advanceBlink(
    delta: number,
    random: RandomSource,
    targetChanged: boolean,
  ): void {
    if (targetChanged) {
      this.blinkHazardBoost = this.profile.blinkAttentionHazardBoost;
    }

    if (this.blinkPhase === 'waiting') {
      this.blinkWaitSeconds -= delta * (1 + this.blinkHazardBoost);
      this.blinkHazardBoost = 0;
      if (this.blinkWaitSeconds > 0) return;
      this.blinkPhase = 'closing';
      this.blinkElapsedSeconds = 0;
    }

    this.blinkElapsedSeconds += delta;
    const closeEnd = this.profile.blinkCloseSeconds;
    const holdEnd = closeEnd + this.profile.blinkHoldSeconds;
    const blinkEnd = holdEnd + this.profile.blinkOpenSeconds;

    if (this.blinkElapsedSeconds < closeEnd) return;
    if (this.blinkElapsedSeconds < holdEnd) {
      this.blinkPhase = 'holding';
      return;
    }
    if (this.blinkElapsedSeconds < blinkEnd) {
      this.blinkPhase = 'opening';
      return;
    }

    this.blinkPhase = 'waiting';
    this.blinkElapsedSeconds = 0;
    this.blinkWaitSeconds = randomBetween(
      this.profile.blinkIntervalSeconds,
      random,
    );
  }

  private advanceOrienting(
    delta: number,
    inputs: NormalizedInputs,
  ): boolean {
    const requestedTarget =
      inputs.attentionTarget &&
      (inputs.attention[inputs.attentionTarget] ?? 0) > 0.01
        ? inputs.attentionTarget
        : null;
    const targetChanged = requestedTarget !== this.orientingTarget;

    if (requestedTarget !== null) {
      if (targetChanged) {
        this.orientingTarget = requestedTarget;
        this.orientingPhase = 'approaching';
        this.orientingElapsedSeconds = 0;
      } else if (this.orientingPhase === 'returning') {
        this.orientingPhase = 'approaching';
        this.orientingElapsedSeconds = 0;
      }
      this.orientingStrength =
        this.signals.attention.get(requestedTarget) ??
        inputs.attention[requestedTarget] ??
        0;
    } else if (this.orientingTarget !== null) {
      if (this.orientingPhase !== 'returning') {
        this.orientingPhase = 'returning';
        this.orientingElapsedSeconds = 0;
      }
    }

    if (this.orientingPhase === 'approaching') {
      this.orientingElapsedSeconds += delta;
      if (
        this.orientingElapsedSeconds >= this.profile.gazeApproachSeconds
      ) {
        this.orientingElapsedSeconds = this.profile.gazeApproachSeconds;
        this.orientingPhase = 'holding';
      }
    } else if (this.orientingPhase === 'holding') {
      this.orientingElapsedSeconds = this.profile.gazeApproachSeconds;
    } else if (this.orientingPhase === 'returning') {
      this.orientingElapsedSeconds += delta;
      if (this.orientingElapsedSeconds >= this.profile.gazeReturnSeconds) {
        this.orientingElapsedSeconds = this.profile.gazeReturnSeconds;
        this.orientingPhase = 'neutral';
        this.orientingTarget = null;
        this.orientingStrength = 0;
      }
    }

    return targetChanged;
  }

  private advanceGesture(
    delta: number,
    inputs: NormalizedInputs,
  ): void {
    const triggerEdge = inputs.gestureTrigger && !this.previousGestureTrigger;
    this.previousGestureTrigger = inputs.gestureTrigger;

    if (triggerEdge && inputs.gestureIntent) {
      this.gestureIntent = inputs.gestureIntent;
      this.gesturePhase = 'onset';
      this.gestureElapsedSeconds = 0;
    }

    if (this.gesturePhase === 'idle') return;

    this.gestureElapsedSeconds += delta;
    if (
      this.gesturePhase === 'onset' &&
      this.gestureElapsedSeconds >= this.profile.gestureOnsetSeconds
    ) {
      this.gesturePhase = 'sustain';
      this.gestureElapsedSeconds = 0;
    } else if (
      this.gesturePhase === 'sustain' &&
      this.gestureElapsedSeconds >= this.profile.gestureSustainSeconds
    ) {
      this.gesturePhase = 'decay';
      this.gestureElapsedSeconds = 0;
    } else if (
      this.gesturePhase === 'decay' &&
      this.gestureElapsedSeconds >= this.profile.gestureDecaySeconds
    ) {
      this.gesturePhase = 'idle';
      this.gestureElapsedSeconds = 0;
      this.gestureIntent = null;
    }
  }

  private createSnapshot(inputs: NormalizedInputs): LifeDynamicsSnapshot {
    const orienting = this.getOrientingWeights(inputs);
    const gesture = this.getGestureProgress();
    return {
      profileId: this.profile.id,
      signals: {
        arousal: this.signals.arousal,
        curiosity: this.signals.curiosity,
        attention: Object.fromEntries(
          [...this.signals.attention.entries()].sort(([left], [right]) =>
            left.localeCompare(right),
          ),
        ),
        speechUrge: this.signals.speechUrge,
        inhibition: this.signals.inhibition,
      },
      modulation: {
        energy: inputs.energy,
        emotion: inputs.emotion,
        intent: inputs.intent,
      },
      life: {
        breathingPhase: this.breathingPhase,
        swayPhase: this.swayPhase,
        noise: this.noise,
      },
      blink: {
        state: this.blinkPhase === 'waiting' ? 'waiting' : 'blinking',
        phase: this.blinkPhase,
        weight: this.getBlinkWeight(),
      },
      orienting: {
        target: this.orientingTarget,
        phase: this.orientingPhase,
        transitionProgress: orienting.transitionProgress,
        eyeWeight: orienting.eyeWeight,
        headWeight: orienting.headWeight,
        torsoWeight: orienting.torsoWeight,
      },
      gesture: {
        intent: this.gestureIntent,
        phase: this.gesturePhase,
        progress: gesture.progress,
        weight: gesture.weight,
      },
    };
  }

  private getBlinkWeight(): number {
    if (this.blinkPhase === 'waiting') return 0;
    const closeEnd = this.profile.blinkCloseSeconds;
    const holdEnd = closeEnd + this.profile.blinkHoldSeconds;
    const blinkEnd = holdEnd + this.profile.blinkOpenSeconds;
    if (this.blinkPhase === 'closing') {
      return clamp(
        this.blinkElapsedSeconds / this.profile.blinkCloseSeconds,
      );
    }
    if (this.blinkPhase === 'holding') return 1;
    return clamp(
      1 -
        (this.blinkElapsedSeconds - holdEnd) /
          Math.max(blinkEnd - holdEnd, 0.0001),
    );
  }

  private getOrientingWeights(inputs: NormalizedInputs): {
    transitionProgress: number;
    eyeWeight: number;
    headWeight: number;
    torsoWeight: number;
  } {
    if (this.orientingPhase === 'neutral') {
      return {
        transitionProgress: 0,
        eyeWeight: 0,
        headWeight: 0,
        torsoWeight: 0,
      };
    }

    const attentionStrength = clamp(this.orientingStrength);
    let eyeProgress = 0;
    let headProgress = 0;
    let torsoProgress = 0;
    if (
      this.orientingPhase === 'approaching' ||
      this.orientingPhase === 'holding'
    ) {
      eyeProgress = smoothstep(
        this.orientingElapsedSeconds,
        0,
        this.profile.gazeApproachSeconds,
      );
      headProgress = smoothstep(
        this.orientingElapsedSeconds - this.profile.headLagSeconds,
        0,
        this.profile.gazeApproachSeconds,
      );
      torsoProgress = smoothstep(
        this.orientingElapsedSeconds - this.profile.torsoLagSeconds,
        0,
        this.profile.gazeApproachSeconds,
      );
    } else {
      const returnProgress = smoothstep(
        this.orientingElapsedSeconds,
        0,
        this.profile.gazeReturnSeconds,
      );
      eyeProgress = 1 - returnProgress;
      headProgress = 1 - returnProgress;
      torsoProgress = 1 - returnProgress;
    }

    const bodyDrive = clamp(0.7 + inputs.arousal * 0.3);
    const inhibition = clamp(inputs.inhibition);
    return {
      transitionProgress: clamp(eyeProgress),
      eyeWeight: clamp(eyeProgress * attentionStrength),
      headWeight: clamp(
        headProgress * attentionStrength * bodyDrive * (1 - inhibition * 0.5),
      ),
      torsoWeight: clamp(
        torsoProgress * attentionStrength * bodyDrive * (1 - inhibition),
      ),
    };
  }

  private getGestureProgress(): { progress: number; weight: number } {
    if (this.gesturePhase === 'idle') return { progress: 0, weight: 0 };
    if (this.gesturePhase === 'onset') {
      const progress = clamp(
        this.gestureElapsedSeconds / this.profile.gestureOnsetSeconds,
      );
      return { progress, weight: progress };
    }
    if (this.gesturePhase === 'sustain') return { progress: 1, weight: 1 };
    const progress = clamp(
      this.gestureElapsedSeconds / this.profile.gestureDecaySeconds,
    );
    return { progress: 1 - progress, weight: 1 - progress };
  }
}

function normalizeInputs(inputs: LifeDynamicsInputs): NormalizedInputs {
  const attention: Record<string, number> = {};
  for (const [target, value] of Object.entries(inputs.attention ?? {})) {
    if (!target.trim()) continue;
    attention[target] = clamp(value);
  }

  return {
    arousal: clamp(inputs.arousal),
    curiosity: clamp(inputs.curiosity),
    attention,
    attentionTarget:
      typeof inputs.attentionTarget === 'string' &&
      inputs.attentionTarget.trim()
        ? inputs.attentionTarget
        : null,
    speechUrge: clamp(inputs.speechUrge),
    inhibition: clamp(inputs.inhibition),
    energy: clamp(inputs.energy),
    emotion: typeof inputs.emotion === 'string' ? inputs.emotion : 'neutral',
    intent:
      typeof inputs.intent === 'string' && inputs.intent.trim()
        ? inputs.intent
        : null,
    gestureIntent:
      typeof inputs.gestureIntent === 'string' && inputs.gestureIntent.trim()
        ? inputs.gestureIntent
        : null,
    gestureTrigger: inputs.gestureTrigger === true,
  };
}

function moveToward(
  current: number,
  target: number,
  delta: number,
  riseSeconds: number,
  decaySeconds: number,
): number {
  const duration = target >= current ? riseSeconds : decaySeconds;
  const alpha = 1 - Math.exp(-delta / Math.max(duration, 0.0001));
  return clamp(current + (target - current) * alpha);
}

function advancePhase(
  phase: number,
  delta: number,
  periodSeconds: number,
): number {
  const period = Math.max(periodSeconds, 0.0001);
  return (phase + (delta / period) * Math.PI * 2) % (Math.PI * 2);
}

function smoothstep(value: number, start: number, end: number): number {
  if (end <= start) return value >= end ? 1 : 0;
  const normalized = clamp((value - start) / (end - start));
  return normalized * normalized * (3 - 2 * normalized);
}

function randomBetween(
  range: readonly [number, number],
  random: RandomSource,
): number {
  const normalized = normalizeRandom(random());
  return range[0] + (range[1] - range[0]) * normalized;
}

function scaleRange(
  range: readonly [number, number],
  scale: number,
): readonly [number, number] {
  return [range[0] * scale, range[1] * scale];
}

function normalizeRandom(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return clamp(value);
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  if (!Number.isFinite(value)) return minimum;
  return Math.max(minimum, Math.min(value, maximum));
}

function freezeSnapshot<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  if (Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value as Record<string, unknown>)) {
    freezeSnapshot(child);
  }
  return value;
}
