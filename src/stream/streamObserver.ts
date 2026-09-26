import {
  STREAM_OBSERVE_PATH,
  type StreamObserveResult,
  type StreamObservedEvent,
  type StreamObservation,
} from './streamContract.js';
import { GameCapture } from './gameCapture.js';
import { computeLumaDiff, isStaticFrame } from './staticFrameSkip.js';

export type StreamEventSignificance = 'low' | 'medium' | 'high';

export interface StreamEvidenceInput {
  id: string;
  kind: 'environment_change';
  at: number;
  semanticKey: string;
  content: string;
  wakeConditions: ['new_evidence'];
  reasonProposals: {
    kind: 'environment_change';
    content: string;
    semanticKey: string;
    salience: number;
  }[];
}

export interface StreamObserverStatus {
  running: boolean;
  capturing: boolean;
  lastFrameAt: number | null;
  lastObserveAt: number | null;
  lastChangeAt: number | null;
  consecutiveErrors: number;
  lastError: string | null;
  lastObservation: StreamObservation | null;
}

export interface StreamObserverOptions {
  provider?: string;
  imageDetail?: 'low' | 'high';
  // Idle time between observation cycles after a window was captured.
  cadenceMs?: number;
  // Even a static scene gets re-observed at least this often so the
  // rolling context does not go stale.
  maxStaleMs?: number;
  // Per event-kind: the same kind cannot raise evidence twice within
  // this window. This is the first brake on repeated narration.
  eventCooldownMs?: number;
  minSignificance?: StreamEventSignificance;
  staticThreshold?: number;
  onEvidence: (evidence: StreamEvidenceInput) => void;
  onObservation?: (observation: StreamObservation) => void;
  onStatus?: (status: StreamObserverStatus) => void;
}

const DEFAULT_CADENCE_MS = 10_000;
const DEFAULT_MAX_STALE_MS = 120_000;
const DEFAULT_EVENT_COOLDOWN_MS = 180_000;
const ERROR_BACKOFF_MS = 15_000;
const OBSERVE_TIMEOUT_MS = 20_000;
const OBSERVED_EVENT_KINDS = [
  'combat',
  'enemy_visible',
  'container',
  'player_state',
  'environment_change',
  'menu',
  'other',
] as const;
const SIGNIFICANCE_ORDER: StreamEventSignificance[] = ['low', 'medium', 'high'];
const SIGNIFICANCE_SALIENCE: Record<StreamEventSignificance, number> = {
  low: 0.3,
  medium: 0.55,
  high: 0.85,
};

export function streamEventSemanticKey(kind: string): string {
  const safe = OBSERVED_EVENT_KINDS.includes(
    kind as (typeof OBSERVED_EVENT_KINDS)[number],
  )
    ? kind
    : 'other';
  return `game:7dtd:${safe}`;
}

export function isEventCooldownActive(
  lastFiredAt: number | undefined,
  now: number,
  cooldownMs: number,
): boolean {
  return lastFiredAt !== undefined && now - lastFiredAt < cooldownMs;
}

export function meetsMinSignificance(
  significance: StreamEventSignificance,
  minimum: StreamEventSignificance,
): boolean {
  return (
    SIGNIFICANCE_ORDER.indexOf(significance) >=
    SIGNIFICANCE_ORDER.indexOf(minimum)
  );
}

// Converts one observed event into autonomy evidence. Returns null
// for events below the significance floor or with no usable summary.
export function buildStreamEvidence(
  event: StreamObservedEvent,
  at: number,
  minSignificance: StreamEventSignificance = 'medium',
): StreamEvidenceInput | null {
  const significance: StreamEventSignificance = SIGNIFICANCE_ORDER.includes(
    event.significance,
  )
    ? event.significance
    : 'low';
  if (!meetsMinSignificance(significance, minSignificance)) return null;
  const content = event.summary.trim().slice(0, 200);
  if (!content) return null;
  const semanticKey = streamEventSemanticKey(event.kind);
  const salience = SIGNIFICANCE_SALIENCE[significance];
  return {
    id: `game:${event.kind}:${at}`,
    kind: 'environment_change',
    at,
    semanticKey,
    content,
    wakeConditions: ['new_evidence'],
    reasonProposals: [
      {
        kind: 'environment_change',
        content,
        semanticKey,
        salience,
      },
    ],
  };
}

const initialStatus = (): StreamObserverStatus => ({
  running: false,
  capturing: false,
  lastFrameAt: null,
  lastObserveAt: null,
  lastChangeAt: null,
  consecutiveErrors: 0,
  lastError: null,
  lastObservation: null,
});

export class StreamObserver {
  private capture: GameCapture | null = null;
  private timer: number | null = null;
  private inFlight = false;
  private stopped = true;
  private lastLuma: Uint8ClampedArray | null = null;
  private lastChangeAt = 0;
  private eventCooldowns = new Map<string, number>();
  private status: StreamObserverStatus = initialStatus();

  constructor(private readonly options: StreamObserverOptions) {}

  private publish(): void {
    this.options.onStatus?.({ ...this.status });
  }

  async start(): Promise<void> {
    if (!this.stopped) return;
    this.stopped = false;
    const capture = new GameCapture();
    await capture.start(() => this.handleCaptureEnded());
    this.capture = capture;
    this.status = { ...initialStatus(), running: true, capturing: true };
    this.publish();
    this.schedule(1500);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
    this.capture?.stop();
    this.capture = null;
    this.status = { ...this.status, running: false, capturing: false };
    this.publish();
  }

  private handleCaptureEnded(): void {
    this.stop();
  }

  private schedule(delayMs: number): void {
    if (this.stopped) return;
    if (this.timer !== null) window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      void this.tick();
    }, delayMs);
  }

  private async tick(): Promise<void> {
    if (this.stopped || this.inFlight || !this.capture) return;
    this.inFlight = true;
    try {
      const window_ = await this.capture.captureWindow();
      const now = Date.now();
      this.status.lastFrameAt = now;
      const diff = this.lastLuma
        ? computeLumaDiff(this.lastLuma, window_.luma)
        : 1;
      this.lastLuma = window_.luma;
      const stale =
        now - this.lastChangeAt >=
        (this.options.maxStaleMs ?? DEFAULT_MAX_STALE_MS);
      if (isStaticFrame(diff, this.options.staticThreshold) && !stale) {
        this.publish();
        this.schedule(this.options.cadenceMs ?? DEFAULT_CADENCE_MS);
        return;
      }

      const result = await postObserve(
        window_.sheet,
        this.options.provider ?? 'deepseek-vision',
        this.options.imageDetail,
      );
      this.status.lastObserveAt = Date.now();
      if (result.error || !result.observation) {
        this.status.consecutiveErrors += 1;
        this.status.lastError =
          result.error?.message ?? 'Observation parse failed.';
      } else {
        this.status.consecutiveErrors = 0;
        this.status.lastError = null;
        this.handleObservation(result.observation);
      }
      this.publish();
      this.schedule(this.options.cadenceMs ?? DEFAULT_CADENCE_MS);
    } catch (error) {
      if (!this.capture?.active) {
        this.stop();
        return;
      }
      this.status.consecutiveErrors += 1;
      this.status.lastError = String(error);
      this.publish();
      this.schedule(ERROR_BACKOFF_MS);
    } finally {
      this.inFlight = false;
    }
  }

  private handleObservation(observation: StreamObservation): void {
    const now = Date.now();
    this.status.lastObservation = observation;
    if (observation.changed) {
      this.lastChangeAt = now;
      this.status.lastChangeAt = now;
    }
    this.options.onObservation?.(observation);

    const minSignificance = this.options.minSignificance ?? 'medium';
    const cooldownMs =
      this.options.eventCooldownMs ?? DEFAULT_EVENT_COOLDOWN_MS;
    for (const event of observation.events) {
      const evidence = buildStreamEvidence(event, now, minSignificance);
      if (!evidence) continue;
      if (
        isEventCooldownActive(
          this.eventCooldowns.get(evidence.semanticKey),
          now,
          cooldownMs,
        )
      ) {
        continue;
      }
      this.eventCooldowns.set(evidence.semanticKey, now);
      this.options.onEvidence(evidence);
    }
  }
}

async function postObserve(
  sheet: Blob,
  provider: string,
  detail?: 'low' | 'high',
): Promise<StreamObserveResult> {
  const params = new URLSearchParams({ provider });
  if (detail) params.set('detail', detail);
  const response = await fetch(`${STREAM_OBSERVE_PATH}?${params.toString()}`, {
    method: 'POST',
    headers: { 'Content-Type': 'image/jpeg' },
    body: sheet,
    signal: AbortSignal.timeout(OBSERVE_TIMEOUT_MS),
  });
  if (!response.ok) {
    throw new Error(`Observe request failed: HTTP ${response.status}`);
  }
  return (await response.json()) as StreamObserveResult;
}
