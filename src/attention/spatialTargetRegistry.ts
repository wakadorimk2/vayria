import type {
  SpatialTargetKind,
  SpatialTargetSelection,
} from '../performer/types.js';

export interface SpatialTargetRect {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface SpatialTargetElement {
  isConnected?: boolean;
  getBoundingClientRect(): SpatialTargetRect;
}

export interface SpatialViewportPoint {
  readonly x: number;
  readonly y: number;
}

export interface SpatialTargetSnapshot {
  readonly selection: SpatialTargetSelection;
  readonly point: SpatialViewportPoint;
  readonly capturedAt: number;
}

export const SPATIAL_TARGET_INVALID_GRACE_MS = 100;

export type SpatialTargetInvalidReason =
  | 'disconnected'
  | 'invalid-rect';

export type SpatialTargetResolutionReason =
  | 'valid'
  | 'last-valid-grace'
  | 'default-fallback'
  | 'missing';

export interface SpatialTargetResolution {
  readonly requested: SpatialTargetSelection;
  readonly snapshot: SpatialTargetSnapshot | null;
  readonly valid: boolean;
  readonly usingLastValid: boolean;
  readonly reason: SpatialTargetResolutionReason;
  readonly invalidReason: SpatialTargetInvalidReason | null;
  readonly invalidSince: number | null;
}

interface CachedTransientTarget {
  element: SpatialTargetElement;
  snapshot: SpatialTargetSnapshot;
  invalidSince: number | null;
  invalidReason: SpatialTargetInvalidReason | null;
}

/**
 * Stores event-driven viewport anchors for semantic attention targets.
 *
 * This registry owns cached positions only. It does not resolve viewport
 * points into stage or world coordinates.
 */
export class SpatialTargetRegistry {
  private readonly defaultElements = new Map<
    SpatialTargetKind,
    SpatialTargetElement
  >();
  private readonly defaultTargets = new Map<
    SpatialTargetKind,
    SpatialTargetSnapshot
  >();
  private readonly defaultObservers = new Map<
    SpatialTargetKind,
    ResizeObserver
  >();
  private readonly transientTargets = new Map<
    SpatialTargetKind,
    CachedTransientTarget
  >();
  private readonly transientObservers = new Map<
    SpatialTargetKind,
    ResizeObserver
  >();
  private disposed = false;

  private readonly handleLayoutInvalidation = (): void => {
    this.refreshDefaults();
    this.refreshTransients();
  };

  constructor() {
    if (typeof window === 'undefined') return;
    window.addEventListener('resize', this.handleLayoutInvalidation);
    window.addEventListener('scroll', this.handleLayoutInvalidation, true);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    if (typeof window !== 'undefined') {
      window.removeEventListener('resize', this.handleLayoutInvalidation);
      window.removeEventListener('scroll', this.handleLayoutInvalidation, true);
    }
    for (const observer of this.defaultObservers.values()) {
      observer.disconnect();
    }
    for (const observer of this.transientObservers.values()) {
      observer.disconnect();
    }
    this.defaultObservers.clear();
    this.transientObservers.clear();
    this.defaultElements.clear();
    this.defaultTargets.clear();
    this.transientTargets.clear();
  }

  registerDefault(
    kind: SpatialTargetKind,
    element: SpatialTargetElement | null,
  ): boolean {
    if (this.disposed) return false;
    if (element === null) {
      this.disconnectDefaultObserver(kind);
      this.defaultElements.delete(kind);
      this.defaultTargets.delete(kind);
      return false;
    }

    if (this.defaultElements.get(kind) !== element) {
      this.disconnectDefaultObserver(kind);
      this.defaultElements.set(kind, element);
      this.observeDefault(kind, element);
    }
    return this.refreshDefault(kind);
  }

  refreshDefault(kind: SpatialTargetKind): boolean {
    if (this.disposed) return false;
    const element = this.defaultElements.get(kind);
    if (!element || !isConnected(element)) {
      this.disconnectDefaultObserver(kind);
      this.defaultTargets.delete(kind);
      return false;
    }

    const point = readElementCenter(element);
    if (point === null) {
      this.defaultTargets.delete(kind);
      return false;
    }

    this.defaultTargets.set(kind, {
      selection: { kind, anchor: 'default' },
      point,
      capturedAt: readNow(),
    });
    return true;
  }

  refreshDefaults(): void {
    if (this.disposed) return;
    for (const kind of this.defaultElements.keys()) {
      this.refreshDefault(kind);
    }
  }

  captureTransient(
    kind: SpatialTargetKind,
    element: SpatialTargetElement | null,
  ): boolean {
    if (this.disposed) return false;
    if (element === null || !isConnected(element)) {
      this.clearTransient(kind);
      return false;
    }

    const point = readElementCenter(element);
    if (point === null) {
      this.clearTransient(kind);
      return false;
    }

    if (this.transientTargets.get(kind)?.element !== element) {
      this.disconnectTransientObserver(kind);
      this.observeTransient(kind, element);
    }
    this.transientTargets.set(kind, {
      element,
      snapshot: {
        selection: { kind, anchor: 'transient' },
        point,
        capturedAt: readNow(),
      },
      invalidSince: null,
      invalidReason: null,
    });
    return true;
  }

  refreshTransient(kind: SpatialTargetKind, now = readNow()): boolean {
    if (this.disposed) return false;
    const cached = this.transientTargets.get(kind);
    if (!cached) {
      return false;
    }

    const timestamp = Number.isFinite(now) ? now : readNow();
    if (!isConnected(cached.element)) {
      this.markTransientInvalid(cached, timestamp, 'disconnected');
      return false;
    }

    const point = readElementCenter(cached.element);
    if (point === null) {
      this.markTransientInvalid(cached, timestamp, 'invalid-rect');
      return false;
    }

    cached.snapshot = {
      selection: { kind, anchor: 'transient' },
      point,
      capturedAt: timestamp,
    };
    cached.invalidSince = null;
    cached.invalidReason = null;
    return true;
  }

  refreshTransients(): void {
    if (this.disposed) return;
    for (const kind of this.transientTargets.keys()) {
      this.refreshTransient(kind);
    }
  }

  clearTransient(kind: SpatialTargetKind): void {
    this.disconnectTransientObserver(kind);
    this.transientTargets.delete(kind);
  }

  resolve(selection: SpatialTargetSelection): SpatialTargetSnapshot | null {
    return this.resolveWithStatus(selection).snapshot;
  }

  resolveWithStatus(
    selection: SpatialTargetSelection,
    now = readNow(),
  ): SpatialTargetResolution {
    if (this.disposed) {
      return createResolution(
        selection,
        null,
        false,
        false,
        'missing',
        null,
        null,
      );
    }

    const timestamp = Number.isFinite(now) ? now : readNow();
    if (selection.anchor === 'default') {
      return createResolution(
        selection,
        this.defaultTargets.get(selection.kind) ?? null,
        this.defaultTargets.has(selection.kind),
        false,
        this.defaultTargets.has(selection.kind) ? 'valid' : 'missing',
        null,
        null,
      );
    }

    const transient = this.transientTargets.get(selection.kind);
    if (transient) {
      if (transient.invalidSince === null && !isConnected(transient.element)) {
        this.markTransientInvalid(transient, timestamp, 'disconnected');
      }

      if (transient.invalidSince === null) {
        return createResolution(
          selection,
          transient.snapshot,
          true,
          false,
          'valid',
          null,
          null,
        );
      }

      if (
        timestamp - transient.invalidSince <=
        SPATIAL_TARGET_INVALID_GRACE_MS
      ) {
        return createResolution(
          selection,
          transient.snapshot,
          false,
          true,
          'last-valid-grace',
          transient.invalidReason,
          transient.invalidSince,
        );
      }
    }

    const defaultSnapshot = this.defaultTargets.get(selection.kind) ?? null;
    return createResolution(
      selection,
      defaultSnapshot,
      defaultSnapshot !== null,
      false,
      defaultSnapshot !== null ? 'default-fallback' : 'missing',
      transient?.invalidReason ?? null,
      transient?.invalidSince ?? null,
    );
  }

  private markTransientInvalid(
    cached: CachedTransientTarget,
    now: number,
    reason: SpatialTargetInvalidReason,
  ): void {
    cached.invalidSince ??= now;
    cached.invalidReason = reason;
  }

  private observeDefault(
    kind: SpatialTargetKind,
    element: SpatialTargetElement,
  ): void {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => this.refreshDefault(kind));
    observer.observe(element as Element);
    this.defaultObservers.set(kind, observer);
  }

  private disconnectDefaultObserver(kind: SpatialTargetKind): void {
    const observer = this.defaultObservers.get(kind);
    if (!observer) return;
    observer.disconnect();
    this.defaultObservers.delete(kind);
  }

  private observeTransient(
    kind: SpatialTargetKind,
    element: SpatialTargetElement,
  ): void {
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => this.refreshTransient(kind));
    observer.observe(element as Element);
    this.transientObservers.set(kind, observer);
  }

  private disconnectTransientObserver(kind: SpatialTargetKind): void {
    const observer = this.transientObservers.get(kind);
    if (!observer) return;
    observer.disconnect();
    this.transientObservers.delete(kind);
  }
}

function createResolution(
  requested: SpatialTargetSelection,
  snapshot: SpatialTargetSnapshot | null,
  valid: boolean,
  usingLastValid: boolean,
  reason: SpatialTargetResolutionReason,
  invalidReason: SpatialTargetInvalidReason | null,
  invalidSince: number | null,
): SpatialTargetResolution {
  return {
    requested,
    snapshot,
    valid,
    usingLastValid,
    reason,
    invalidReason,
    invalidSince,
  };
}

function isConnected(element: SpatialTargetElement): boolean {
  return element.isConnected !== false;
}

function readElementCenter(
  element: SpatialTargetElement,
): SpatialViewportPoint | null {
  try {
    const rect = element.getBoundingClientRect();
    if (
      !Number.isFinite(rect.left) ||
      !Number.isFinite(rect.top) ||
      !Number.isFinite(rect.width) ||
      !Number.isFinite(rect.height) ||
      rect.width <= 0 ||
      rect.height <= 0
    ) {
      return null;
    }

    const point = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
    };
    return Number.isFinite(point.x) && Number.isFinite(point.y)
      ? point
      : null;
  } catch {
    return null;
  }
}

function readNow(): number {
  return typeof performance !== 'undefined' && Number.isFinite(performance.now())
    ? performance.now()
    : Date.now();
}
