import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { WildcardCard } from './WildcardCard';
import type { CardMotion } from './cardTypes';
import type {
  CardGamePrototypeController,
  CardSwapResult,
  CardZone,
} from './useCardGamePrototype';

interface CardGamePrototypeProps {
  game: CardGamePrototypeController;
  isInteractionLocked?: boolean;
  onCardInserted?: (result: CardSwapResult) => void;
}

interface DragSession {
  cardId: string;
  height: number;
  isDragging: boolean;
  left: number;
  offsetX: number;
  offsetY: number;
  pointerId: number;
  startX: number;
  startY: number;
  targetBrainCardId: string | null;
  top: number;
  width: number;
}

const DRAG_THRESHOLD_PX = 7;
const DROP_TARGET_MARGIN_PX = 16;

function readBrainCardIdAtPoint(
  clientX: number,
  clientY: number,
): string | null {
  const brainCardsContainer = document.querySelector<HTMLElement>(
    '.card-zone--brain .card-zone__cards',
  );
  if (!brainCardsContainer) return null;

  const containerRect = brainCardsContainer.getBoundingClientRect();
  const isInsideExpandedRow =
    clientX >= containerRect.left - DROP_TARGET_MARGIN_PX &&
    clientX <= containerRect.right + DROP_TARGET_MARGIN_PX &&
    clientY >= containerRect.top - DROP_TARGET_MARGIN_PX &&
    clientY <= containerRect.bottom + DROP_TARGET_MARGIN_PX;
  if (!isInsideExpandedRow) return null;

  const containerStyles = window.getComputedStyle(brainCardsContainer);
  const containerLeft =
    containerRect.left +
    (Number.parseFloat(containerStyles.borderLeftWidth) || 0) +
    (Number.parseFloat(containerStyles.paddingLeft) || 0);
  const gap = Number.parseFloat(containerStyles.columnGap) || 0;
  const brainCardWrappers = Array.from(
    brainCardsContainer.children,
  ).filter((child): child is HTMLElement => child instanceof HTMLElement);
  let cardLeft = containerLeft;
  let nearestCardId: string | null = null;
  let nearestDistance = Number.POSITIVE_INFINITY;

  for (const brainCardWrapper of brainCardWrappers) {
    const cardElement = brainCardWrapper.querySelector<HTMLElement>(
      '[data-card-id]',
    );
    if (!cardElement) {
      cardLeft += brainCardWrapper.offsetWidth + gap;
      continue;
    }

    const cardCenterX = cardLeft + brainCardWrapper.offsetWidth / 2;
    const distance = Math.abs(clientX - cardCenterX);
    if (distance < nearestDistance) {
      nearestDistance = distance;
      nearestCardId = cardElement.dataset.cardId ?? null;
    }

    cardLeft += brainCardWrapper.offsetWidth + gap;
  }

  return nearestCardId;
}

function getBrainDropWaveX(distanceFromTarget: number): string {
  if (distanceFromTarget === 0) return '0px';

  if (distanceFromTarget < 0) {
    return Math.abs(distanceFromTarget) === 1
      ? 'var(--brain-drop-wave-left-near)'
      : 'var(--brain-drop-wave-left-far)';
  }

  return Math.abs(distanceFromTarget) === 1
    ? 'var(--brain-drop-wave-right-near)'
    : 'var(--brain-drop-wave-right-far)';
}

export function CardGamePrototype({
  game,
  isInteractionLocked = false,
  onCardInserted,
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
  const isSpent = zones.remainingInterferenceCount === 0;
  const interactionLocked = isSpent || isInteractionLocked;
  const dragActive = dragState?.isDragging === true;
  const visualInteractionLocked = interactionLocked && !dragActive;
  const brainDropTargetIndex =
    dragState?.isDragging === true && dragState.targetBrainCardId
      ? zones.brain.findIndex(
          (card) => card.id === dragState.targetBrainCardId,
        )
      : -1;

  const commitSwap = useCallback(
    (
      brainCardId: string,
      handCardId: string,
      allowDuringInteractionLock = false,
    ) => {
      if (
        isSpent ||
        (isInteractionLocked && !allowDuringInteractionLock)
      ) {
        return;
      }
      const result = swapCards(brainCardId, handCardId);
      if (!result) return;
      setLastSwap(result);
      onCardInserted?.(result);
    },
    [isInteractionLocked, isSpent, onCardInserted, swapCards],
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
      event?: ReactMouseEvent<HTMLElement>,
    ) => {
      if (suppressNextClickRef.current) {
        if (event) {
          suppressNextClickRef.current = false;
          return;
        }
      }
      if (interactionLocked) return;

      const brainCardId = zone === 'brain' ? cardId : selectedBrainCardId;
      const handCardId = zone === 'hand' ? cardId : selectedHandCardId;
      if (brainCardId && handCardId) {
        commitSwap(brainCardId, handCardId);
        return;
      }

      selectCard(zone, cardId);
    },
    [
      commitSwap,
      interactionLocked,
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
        height: rect.height,
        isDragging: false,
        left: rect.left,
        offsetX: event.clientX - rect.left,
        offsetY: event.clientY - rect.top,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
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
    dragSessionRef.current = null;
    setDragState(null);
    suppressNextClickRef.current = false;
  }, []);

  const completeDrag = useCallback(
    (pointerId: number, clientX: number, clientY: number) => {
      const session = dragSessionRef.current;
      if (!session || session.pointerId !== pointerId) return;

      dragSessionRef.current = null;
      setDragState(null);
      if (!session.isDragging) return;

      suppressNextClickRef.current = true;

      const targetBrainCardId = readBrainCardIdAtPoint(clientX, clientY);
      if (targetBrainCardId) {
        commitSwap(targetBrainCardId, session.cardId, true);
      }
    },
    [commitSwap],
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
      const nextSession: DragSession = {
        ...session,
        isDragging: true,
        left: event.clientX - session.offsetX,
        targetBrainCardId: readBrainCardIdAtPoint(
          event.clientX,
          event.clientY,
        ),
        top: event.clientY - session.offsetY,
      };
      dragSessionRef.current = nextSession;
      setDragState(nextSession);
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
  }, [cancelDrag, completeDrag]);

  const selectionHint = isInteractionLocked
    ? dragActive
      ? '推論中ですが、掴んだカードを脳内へ放して挿入できます'
      : '返答を待っています'
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
    return zones[zone].map((card, cardIndex) => {
      const isActive =
        zone === 'brain' && zones.activatedCardIds.includes(card.id);
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

      const hasDropWave =
        zone === 'brain' && brainDropTargetIndex >= 0;
      const dropWaveX = hasDropWave
        ? getBrainDropWaveX(cardIndex - brainDropTargetIndex)
        : undefined;
      const brainCardFloatStyle = dropWaveX
        ? ({ '--brain-drop-wave-x': dropWaveX } as CSSProperties)
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
            visualInteractionLocked
              ? 'disabled'
              : selectedId === card.id
                ? 'selected'
                : isActive
                  ? 'active'
                  : 'normal'
          }
          interactionDisabled={interactionLocked}
        />
      );

      return zone === 'brain' ? (
        <div
          className={`brain-card-float${hasDropWave ? ' brain-card-float--drop-wave' : ''}`}
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
        <div className="card-zone__cards">{renderCards('brain')}</div>
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
            {import.meta.env.DEV && (
              <button
                className="reset-turn-button"
                disabled={isInteractionLocked}
                onClick={resetTurn}
                type="button"
              >
                Reset Turn
              </button>
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
