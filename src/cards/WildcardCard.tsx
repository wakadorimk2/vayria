import type {
  KeyboardEvent,
  MouseEvent,
  PointerEventHandler,
} from 'react';
import type {
  CardKind,
  CardMotion,
  CardState,
  WildcardCardData,
} from './cardTypes';
import { getVisibleCardStateLabel } from './cardPresentation';
import './cards.css';
import { CardArtwork } from './CardArtwork';

export interface WildcardCardProps {
  card: WildcardCardData;
  interactionDisabled?: boolean;
  onSelect?: (
    event?: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>,
  ) => void;
  onPointerDown?: PointerEventHandler<HTMLElement>;
  motion?: CardMotion;
  state?: CardState;
  showStateLabel?: boolean;
  showArtwork?: boolean;
}

const KIND_LABELS: Record<CardKind, string> = {
  concept: 'concept',
  mood: 'mood',
  effect: 'effect',
};

const KIND_MARKS: Record<CardKind, string> = {
  concept: '◇',
  mood: '●',
  effect: '✦',
};

const MOTION_LABELS: Record<CardMotion, string> = {
  none: '',
  dragging: '、移動中',
  'drop-target': '、投入先',
  'pending-insertion': '、挿入後の返答待ち',
  inserted: '、挿入',
  ejected: '、押し出し',
};

const CARD_MOTIFS: Partial<Record<string, string>> = {
  chicken: '○',
  suspicious: '••',
  sleepy: '˘',
  rain: '•••',
  secret: '●',
  panic: '!',
  sparkle: '✦ ･ ✧',
  underwater: '≈',
  lonely: '·',
  confident: '—',
  'deja-vu': '〃',
  'distant-thunder': 'ϟ',
};

export function WildcardCard({
  card,
  interactionDisabled = false,
  motion = 'none',
  onSelect,
  onPointerDown,
  showStateLabel = false,
  showArtwork = false,
  state = 'normal',
}: WildcardCardProps) {
  const isInteractive = Boolean(onSelect);
  const isDisabled = state === 'disabled';
  const isInputDisabled = isDisabled || interactionDisabled;
  const stateLabel =
    state === 'active' ? '、主役' : state === 'supporting' ? '、補助' : '';
  const motionClass = motion === 'none' ? '' : `wildcard-card--${motion}`;
  const visibleStateLabel = showStateLabel
    ? getVisibleCardStateLabel(state, motion)
    : null;

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (isInputDisabled || !onSelect) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelect(event);
  };

  return (
    <article
      aria-disabled={isInputDisabled || undefined}
      aria-grabbed={motion === 'dragging' || undefined}
      aria-label={`${card.label}、${KIND_LABELS[card.kind]}${stateLabel}${MOTION_LABELS[motion]}`}
      aria-pressed={isInteractive ? state === 'selected' : undefined}
      className={`wildcard-card wildcard-card--${card.kind} wildcard-card--${state} ${motionClass}`.trim()}
      data-card-id={card.id}
      data-motion={motion}
      data-state={state}
      onClick={
        isInputDisabled ? undefined : (event) => onSelect?.(event)
      }
      onKeyDown={isInteractive && !isInputDisabled ? handleKeyDown : undefined}
      onPointerDown={isInputDisabled ? undefined : onPointerDown}
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive && !isInputDisabled ? 0 : undefined}
    >
      <span
        className="wildcard-card__pip wildcard-card__pip--top"
        aria-hidden="true"
      >
        {KIND_MARKS[card.kind]}
      </span>

      {showArtwork && <CardArtwork cardId={card.id} />}
      {!showArtwork && CARD_MOTIFS[card.id] && (
        <span className="wildcard-card__motif" aria-hidden="true">
          {CARD_MOTIFS[card.id]}
        </span>
      )}

      <h2 className="wildcard-card__label" data-label={card.label}>
        {card.label}
      </h2>

      {visibleStateLabel && (
        <span className="wildcard-card__state-label">
          {visibleStateLabel}
        </span>
      )}

      <span
        className="wildcard-card__pip wildcard-card__pip--bottom"
        aria-hidden="true"
      >
        {KIND_MARKS[card.kind]}
      </span>
    </article>
  );
}
