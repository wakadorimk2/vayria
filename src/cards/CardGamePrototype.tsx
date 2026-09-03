import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { WildcardCard } from './WildcardCard';
import { runtimeConfig } from '../runtimeConfig';
import type { CardMotion } from './cardTypes';
import type {
  SpatialTargetRegistry,
  SpatialViewportPoint,
} from '../attention/spatialTargetRegistry';
import type {
  CardGamePrototypeController,
  CardSwapResult,
  CardZone,
} from './useCardGamePrototype';
import {
  resolveCardDropPreview,
  type CardDropPreview,
  type CardDropPreviewLayout,
} from './cardDropPreview';

export interface CardInteractionTarget {
  readonly cardId: string;
  readonly interaction: 'activation' | 'drag-start';
  readonly zone: CardZone;
  readonly element: HTMLElement | null;
}

export interface CardAttentionInput {
  readonly cardId: string;
  readonly interaction: 'activation' | 'drag-start' | 'appearance';
  readonly zone: CardZone;
  readonly element: HTMLElement | null;
}

export interface CardDragPositionUpdate {
  readonly center: SpatialViewportPoint;
  readonly speedPxPerSecond: number;
  readonly capturedAt: number;
}

interface CardGamePrototypeProps {
  game: CardGamePrototypeController;
  isResetLocked?: boolean;
  onCardInserted?: (result: CardSwapResult) => void;
  onCardInteraction?: (target: CardInteractionTarget) => void;
  onCardAttentionInput?: (input: CardAttentionInput) => void;
  onCardDragPositionChange?: (update: CardDragPositionUpdate) => void;
  onCardDragActiveChange?: (isActive: boolean) => void;
  onSessionReset?: () => void;
  onSelectionActiveChange?: (isActive: boolean) => void;
  spatialTargetRegistry?: SpatialTargetRegistry;
}

interface DragSession {
  cardId: string;
  element: HTMLElement;
  height: number;
  isDragging: boolean;
  left: number;
  offsetX: number;
  offsetY: number;
  pointerId: number;
  startX: number;
  startY: number;
  initialCardCenter: SpatialViewportPoint;
  initialPointer: SpatialViewportPoint;
  lastSpatialSampleAt: number;
  lastSpatialSampleCenter: SpatialViewportPoint;
  brainDropLayout: BrainDropLayout | null;
  dropPreview: CardDropPreview | null;
  targetBrainCardId: string | null;
  top: number;
  width: number;
}

type BrainDropLayout = CardDropPreviewLayout;

const DRAG_THRESHOLD_PX = 7;
const DRAG_SPATIAL_SAMPLE_INTERVAL_MS = 80;
const DRAG_SPATIAL_DEAD_ZONE_PX = 16;
const SHOW_DEVELOPER_CONTROLS =
  import.meta.env.DEV && runtimeConfig.mode === 'local';

function readBrainDropLayout(): BrainDropLayout | null {
  const brainCardsContainer = document.querySelector<HTMLElement>(
    '.card-zone--brain .card-zone__cards',
  );
  if (!brainCardsContainer) return null;

  const containerRect = brainCardsContainer.getBoundingClientRect();
  const brainCardWrappers = Array.from(
    brainCardsContainer.children,
  ).filter((child): child is HTMLElement => child instanceof HTMLElement);
  const cards: CardDropPreviewLayout['cards'][number][] = [];
  for (const brainCardWrapper of brainCardWrappers) {
    const cardElement = brainCardWrapper.querySelector<HTMLElement>(
      '[data-card-id]',
    );
    const id = cardElement?.dataset.cardId;
    if (id) {
      const rect = brainCardWrapper.getBoundingClientRect();
      cards.push({
        id,
        centerX: rect.left + rect.width / 2,
        centerY: rect.top + rect.height / 2,
        width: rect.width,
        height: rect.height,
      });
    }
  }

  return {
    left: containerRect.left,
    right: containerRect.right,
    top: containerRect.top,
    bottom: containerRect.bottom,
    cards,
  };
}

function createDragSpatialSample(
  session: DragSession,
  clientX: number,
  clientY: number,
  capturedAt: number,
  force = false,
): {
  nextSampleAt: number;
  nextSampleCenter: SpatialViewportPoint;
  update: CardDragPositionUpdate;
} | null {
  const estimatedCenter: SpatialViewportPoint = {
    x: session.initialCardCenter.x +
      (clientX - session.initialPointer.x),
    y: session.initialCardCenter.y +
      (clientY - session.initialPointer.y),
  };
  const elapsedMs = Math.max(0, capturedAt - session.lastSpatialSampleAt);
  const distance = Math.hypot(
    estimatedCenter.x - session.lastSpatialSampleCenter.x,
    estimatedCenter.y - session.lastSpatialSampleCenter.y,
  );
  if (
    distance < DRAG_SPATIAL_DEAD_ZONE_PX ||
    (!force && elapsedMs < DRAG_SPATIAL_SAMPLE_INTERVAL_MS)
  ) {
    return null;
  }

  return {
    nextSampleAt: capturedAt,
    nextSampleCenter: estimatedCenter,
    update: {
      center: estimatedCenter,
      speedPxPerSecond:
        elapsedMs > 0 ? distance / (elapsedMs / 1_000) : 0,
      capturedAt,
    },
  };
}

function findCardElement(
  container: HTMLElement | null,
  cardId: string,
): HTMLElement | null {
  if (!container) return null;
  const elements = container.querySelectorAll<HTMLElement>('[data-card-id]');
  for (const element of elements) {
    if (element.dataset.cardId === cardId) return element;
  }
  return null;
}

function readPointerTime(): number {
  return typeof performance !== 'undefined' && Number.isFinite(performance.now())
    ? performance.now()
    : Date.now();
}

export function CardGamePrototype({
  game,
  isResetLocked = false,
  onCardInserted,
  onCardInteraction,
  onCardAttentionInput,
  onCardDragPositionChange,
  onCardDragActiveChange,
  onSessionReset,
  onSelectionActiveChange,
  spatialTargetRegistry,
}: CardGamePrototypeProps) {
  const {
    maxInterferenceCount,
    resetTurn,
    selectCard,
    selectedBrainCardId,
    selectedHandCardId,
    swapCards,
    zones,
  } = game;
  const [dragState, setDragState] = useState<DragSession | null>(null);
  const [lastSwap, setLastSwap] = useState<CardSwapResult | null>(null);
  const dragSessionRef = useRef<DragSession | null>(null);
  const suppressNextClickRef = useRef(false);
  const suppressNextAppearanceAttentionRef = useRef(false);
  const brainCardsRef = useRef<HTMLDivElement>(null);
  const isSpent = zones.remainingInterferenceCount === 0;
  const interactionLocked = isSpent;
  const dragActive = dragState?.isDragging === true;
  const visualInteractionLocked = interactionLocked && !dragActive;
  const selectionActive =
    dragActive ||
    selectedBrainCardId !== null ||
    selectedHandCardId !== null;

  useEffect(() => {
    onSelectionActiveChange?.(selectionActive);
  }, [onSelectionActiveChange, selectionActive]);

  useLayoutEffect(() => {
    if (!spatialTargetRegistry) return;
    spatialTargetRegistry.registerDefault('game', brainCardsRef.current);
    return () => {
      spatialTargetRegistry.registerDefault('game', null);
    };
  }, [spatialTargetRegistry]);

  useLayoutEffect(() => {
    if (!spatialTargetRegistry) return;
    spatialTargetRegistry.refreshDefault('game');
  }, [spatialTargetRegistry, zones.brain]);

  useLayoutEffect(() => {
    if (!spatialTargetRegistry || dragState?.isDragging !== true) return;
    spatialTargetRegistry.setTransientDragActive('game', true);
  }, [dragState?.isDragging, spatialTargetRegistry]);

  useLayoutEffect(() => {
    if (!lastSwap) return;
    if (suppressNextAppearanceAttentionRef.current) {
      suppressNextAppearanceAttentionRef.current = false;
      return;
    }
    const element = findCardElement(
      brainCardsRef.current,
      lastSwap.insertedCardId,
    );
    onCardAttentionInput?.({
      cardId: lastSwap.insertedCardId,
      element,
      interaction: 'appearance',
      zone: 'brain',
    });
  }, [lastSwap, onCardAttentionInput]);

  const commitSwap = useCallback(
    (brainCardId: string, handCardId: string) => {
      if (isSpent) return false;
      const result = swapCards(brainCardId, handCardId);
      if (!result) return false;
      setLastSwap(result);
      onCardInserted?.(result);
      return true;
    },
    [isSpent, onCardInserted, swapCards],
  );

  useEffect(() => {
    if (!lastSwap) return;
    const timeoutId = window.setTimeout(() => setLastSwap(null), 720);
    return () => window.clearTimeout(timeoutId);
  }, [lastSwap]);

  const handleCardActivation = useCallback(
    (
      zone: CardZone,
      cardId: string,
      event?: ReactMouseEvent<HTMLElement> | ReactKeyboardEvent<HTMLElement>,
    ) => {
      if (suppressNextClickRef.current) {
        if (event) {
          suppressNextClickRef.current = false;
          return;
        }
      }
      if (interactionLocked) return;

      onCardAttentionInput?.({
        cardId,
        element: event?.currentTarget ?? null,
        interaction: 'activation',
        zone,
      });
      onCardInteraction?.({
        cardId,
        element: event?.currentTarget ?? null,
        interaction: 'activation',
        zone,
      });
      const brainCardId = zone === 'brain' ? cardId : selectedBrainCardId;
      const handCardId = zone === 'hand' ? cardId : selectedHandCardId;
      if (brainCardId && handCardId) {
        if (commitSwap(brainCardId, handCardId)) {
          suppressNextAppearanceAttentionRef.current = true;
        }
        return;
      }

      selectCard(zone, cardId);
    },
    [
      commitSwap,
      interactionLocked,
      onCardAttentionInput,
      onCardInteraction,
      selectCard,
      selectedBrainCardId,
      selectedHandCardId,
    ],
  );

  const handlePointerDown = useCallback(
    (cardId: string, event: ReactPointerEvent<HTMLElement>) => {
      if (interactionLocked) return;
      if (event.pointerType === 'mouse' && event.button !== 0) return;
      suppressNextClickRef.current = false;

      const rect = event.currentTarget.getBoundingClientRect();
      const session: DragSession = {
        cardId,
        element: event.currentTarget,
        height: rect.height,
        isDragging: false,
        left: rect.left,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        initialCardCenter: {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        },
        initialPointer: {
          x: event.clientX,
          y: event.clientY,
        },
        lastSpatialSampleAt: readPointerTime(),
        lastSpatialSampleCenter: {
          x: rect.left + rect.width / 2,
          y: rect.top + rect.height / 2,
        },
        brainDropLayout: readBrainDropLayout(),
        dropPreview: null,
        targetBrainCardId: null,
        top: rect.top,
        width: rect.width,
      };
      dragSessionRef.current = session;
      event.currentTarget.setPointerCapture?.(event.pointerId);
    },
    [interactionLocked],
  );

  const cancelDrag = useCallback(() => {
    if (dragSessionRef.current?.isDragging) {
      onCardDragActiveChange?.(false);
    }
    dragSessionRef.current = null;
    setDragState(null);
    suppressNextClickRef.current = false;
  }, [onCardDragActiveChange]);

  const completeDrag = useCallback(
    (pointerId: number, clientX: number, clientY: number) => {
      const session = dragSessionRef.current;
      if (!session || session.pointerId !== pointerId) return;

      if (session.isDragging) {
        const finalSample = createDragSpatialSample(
          session,
          clientX,
          clientY,
          readPointerTime(),
          true,
        );
        if (finalSample) {
          onCardDragPositionChange?.(finalSample.update);
        }
        onCardDragActiveChange?.(false);
      }
      dragSessionRef.current = null;
      setDragState(null);
      if (!session.isDragging) return;

      suppressNextClickRef.current = true;

      const finalPreview = resolveCardDropPreview(
        session.brainDropLayout,
        {
          x: clientX - session.offsetX + session.width / 2,
          y: clientY - session.offsetY + session.height / 2,
        },
      );
      if (finalPreview) {
        if (commitSwap(finalPreview.targetCardId, session.cardId)) {
          suppressNextAppearanceAttentionRef.current = true;
        }
      }
    },
    [commitSwap, onCardDragActiveChange, onCardDragPositionChange],
  );

  useEffect(() => {
    const handlePointerMove = (event: PointerEvent) => {
      const session = dragSessionRef.current;
      if (!session || session.pointerId !== event.pointerId) return;

      const distance = Math.hypot(
        event.clientX - session.startX,
        event.clientY - session.startY,
      );
      if (!session.isDragging && distance < DRAG_THRESHOLD_PX) return;

      event.preventDefault();
      const startedDragging = !session.isDragging;
      const nextLeft = event.clientX - session.offsetX;
      const nextTop = event.clientY - session.offsetY;
      const dropPreview = resolveCardDropPreview(session.brainDropLayout, {
        x: nextLeft + session.width / 2,
        y: nextTop + session.height / 2,
      });
      let nextSession: DragSession = {
        ...session,
        dropPreview,
        isDragging: true,
        left: nextLeft,
        targetBrainCardId: dropPreview?.targetCardId ?? null,
        top: nextTop,
      };

      dragSessionRef.current = nextSession;
      setDragState(nextSession);
      if (startedDragging) {
        onCardDragActiveChange?.(true);
        onCardAttentionInput?.({
          cardId: session.cardId,
          element: session.element,
          interaction: 'drag-start',
          zone: 'hand',
        });
        onCardInteraction?.({
          cardId: session.cardId,
          element: session.element,
          interaction: 'drag-start',
          zone: 'hand',
        });
      }
      const spatialSample = createDragSpatialSample(
        nextSession,
        event.clientX,
        event.clientY,
        readPointerTime(),
      );
      if (spatialSample) {
        nextSession = {
          ...nextSession,
          lastSpatialSampleAt: spatialSample.nextSampleAt,
          lastSpatialSampleCenter: spatialSample.nextSampleCenter,
        };
        dragSessionRef.current = nextSession;
        setDragState(nextSession);
        onCardDragPositionChange?.(spatialSample.update);
      }
    };
    const handlePointerUp = (event: PointerEvent) => {
      const session = dragSessionRef.current;
      if (session?.isDragging && session.pointerId === event.pointerId) {
        event.preventDefault();
      }
      completeDrag(event.pointerId, event.clientX, event.clientY);
    };
    const handlePointerCancel = () => cancelDrag();
    const handleWindowBlur = () => cancelDrag();

    document.addEventListener('pointermove', handlePointerMove, {
      passive: false,
    });
    document.addEventListener('pointerup', handlePointerUp);
    document.addEventListener('pointercancel', handlePointerCancel);
    window.addEventListener('blur', handleWindowBlur);
    return () => {
      document.removeEventListener('pointermove', handlePointerMove);
      document.removeEventListener('pointerup', handlePointerUp);
      document.removeEventListener('pointercancel', handlePointerCancel);
      window.removeEventListener('blur', handleWindowBlur);
    };
  }, [
    cancelDrag,
    completeDrag,
    onCardAttentionInput,
    onCardDragActiveChange,
    onCardDragPositionChange,
    onCardInteraction,
  ]);

  const selectionHint =
    runtimeConfig.mode === 'exhibition'
        ? isSpent
          ? 'このターンは操作済み'
          : selectionActive
          ? '脳内へ一枚'
          : '気になる一枚を選んで'
      : isSpent
        ? zones.forcedCardId
          ? `脳へ干渉しました。「${zones.brain.find((card) => card.id === zones.forcedCardId)?.label ?? zones.forcedCardId}」の返答を待っています`
          : 'このターンは操作済み'
        : selectedBrainCardId || selectedHandCardId
          ? '反対側のカードを選択すると交換します'
          : '手札から脳内へカードをドラッグ';

  const renderCards = (zone: CardZone) => {
    const selectedId =
      zone === 'brain' ? selectedBrainCardId : selectedHandCardId;
    return zones[zone].map((card) => {
      const isActive =
        zone === 'brain' && zones.activatedCardIds[0] === card.id;
      const isSupporting =
        zone === 'brain' && zones.activatedCardIds[1] === card.id;
      const isPendingInsertion =
        zone === 'brain' && zones.forcedCardId === card.id;
      const isDropTarget =
        zone === 'brain' &&
        dragState?.isDragging === true &&
        dragState.targetBrainCardId === card.id;
      const isDragging =
        zone === 'hand' &&
        dragState?.isDragging === true &&
        dragState.cardId === card.id;
      let motion: CardMotion = 'none';
      if (isDragging) {
        motion = 'dragging';
      } else if (isDropTarget) {
        motion = 'drop-target';
      } else if (
        lastSwap?.insertedCardId === card.id &&
        zone === 'brain'
      ) {
        motion = 'inserted';
      } else if (lastSwap?.ejectedCardId === card.id && zone === 'hand') {
        motion = 'ejected';
      } else if (isPendingInsertion) {
        motion = 'pending-insertion';
      }

      const dropPreview = isDropTarget ? dragState.dropPreview : null;
      const brainCardFloatStyle = dropPreview
        ? ({
            '--brain-drop-progress': dropPreview.progress,
            '--brain-drop-retreat-x': `${dropPreview.retreatX}px`,
            '--brain-drop-retreat-y': `${dropPreview.retreatY}px`,
          } as CSSProperties)
        : undefined;

      const renderedCard = (
        <WildcardCard
          card={card}
          key={card.id}
          motion={motion}
          onPointerDown={
            zone === 'hand'
              ? (event) => handlePointerDown(card.id, event)
              : undefined
          }
          onSelect={(event) => handleCardActivation(zone, card.id, event)}
          state={
            isActive
              ? 'active'
              : isSupporting
                ? 'supporting'
                : visualInteractionLocked
                  ? 'disabled'
                  : selectedId === card.id
                    ? 'selected'
                    : 'normal'
          }
          interactionDisabled={interactionLocked}
        />
      );

      return zone === 'brain' ? (
        <div
          className={`brain-card-float${isDropTarget ? ' brain-card-float--drop-target' : ''}`}
          key={card.id}
          style={brainCardFloatStyle}
        >
          {renderedCard}
        </div>
      ) : (
        renderedCard
      );
    });
  };

  const dragCard = dragState
    ? zones.hand.find((card) => card.id === dragState.cardId)
    : null;

  return (
    <div className="card-prototype" aria-label="Brain and hand cards">
      <section className="card-zone card-zone--brain" aria-label="脳内">
        <header className="card-zone__header">
          <h2>脳内</h2>
        </header>
        <div className="card-zone__cards" ref={brainCardsRef}>
          {renderCards('brain')}
        </div>
      </section>

      <section className="card-zone card-zone--hand" aria-label="手札">
        <header className="card-zone__header card-zone__header--hand">
          <h2>手札</h2>
          <div className="card-zone__turn-status">
            <span
              className={`interference-counter interference-counter--${isSpent ? 'spent' : 'ready'}`}
              aria-label={`残り干渉回数 ${zones.remainingInterferenceCount} / ${maxInterferenceCount}`}
            >
              <span className="interference-counter__label" aria-hidden="true">
                干渉
              </span>
              <span className="interference-counter__slots" aria-hidden="true">
                {Array.from({ length: maxInterferenceCount }, (_, index) => (
                  <span
                    className={`interference-counter__chip ${index < zones.remainingInterferenceCount ? 'interference-counter__chip--available' : 'interference-counter__chip--spent'}`}
                    key={index}
                  />
                ))}
              </span>
            </span>
            {SHOW_DEVELOPER_CONTROLS && (
              <>
                <button
                  className="reset-turn-button"
                  disabled={isResetLocked}
                  onClick={resetTurn}
                  type="button"
                >
                  Reset Turn
                </button>
                {onSessionReset && (
                  <button
                    className="reset-session-button"
                    disabled={isResetLocked}
                    onClick={onSessionReset}
                    type="button"
                  >
                    Session Reset
                  </button>
                )}
              </>
            )}
          </div>
        </header>

        <div className="card-zone__cards">{renderCards('hand')}</div>

        <div className="card-zone__action" aria-live="polite">
          <span>{selectionHint}</span>
        </div>
      </section>

      {dragState?.isDragging && dragCard && (
        <div
          aria-hidden="true"
          className="card-drag-preview"
          style={{
            height: dragState.height,
            left: dragState.left,
            top: dragState.top,
            width: dragState.width,
          }}
        >
          <WildcardCard
            card={dragCard}
            motion="dragging"
            state="selected"
          />
        </div>
      )}
    </div>
  );
}
