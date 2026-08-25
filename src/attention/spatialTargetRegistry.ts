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

interface CachedTransientTarget {
  readonly element: SpatialTargetElement;
  readonly snapshot: SpatialTargetSnapshot;
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
      this.disconnectTransientObserver(kind);
      this.transientTargets.delete(kind);
      return false;
    }

    const point = readElementCenter(element);
    if (point === null) {
      this.disconnectTransientObserver(kind);
      this.transientTargets.delete(kind);
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
    });
    return true;
  }

  refreshTransient(kind: SpatialTargetKind): boolean {
    if (this.disposed) return false;
    const cached = this.transientTargets.get(kind);
    if (!cached || !isConnected(cached.element)) {
      this.disconnectTransientObserver(kind);
      this.transientTargets.delete(kind);
      return false;
    }

    const point = readElementCenter(cached.element);
    if (point === null) {
      this.disconnectTransientObserver(kind);
      this.transientTargets.delete(kind);
      return false;
    }

    this.transientTargets.set(kind, {
      element: cached.element,
      snapshot: {
        selection: { kind, anchor: 'transient' },
        point,
        capturedAt: readNow(),
      },
    });
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
    if (this.disposed) return null;

    if (selection.anchor === 'transient') {
      const transient = this.transientTargets.get(selection.kind);
      if (transient && isConnected(transient.element)) {
        return transient.snapshot;
      }
      if (transient) {
        this.disconnectTransientObserver(selection.kind);
        this.transientTargets.delete(selection.kind);
      }
    }

    return this.defaultTargets.get(selection.kind) ?? null;
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
