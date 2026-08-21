import type { KeyboardEvent } from 'react';
import type {
  CardKind,
  CardState,
  WildcardCardData,
} from './cardTypes';
import './cards.css';

export interface WildcardCardProps {
  card: WildcardCardData;
  onSelect?: () => void;
  state?: CardState;
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
  onSelect,
  state = 'normal',
}: WildcardCardProps) {
  const isInteractive = Boolean(onSelect);
  const isDisabled = state === 'disabled';
  const stateLabel = state === 'active' ? '、発動' : '';

  const handleKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (isDisabled || !onSelect) return;
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onSelect();
  };

  return (
    <article
      aria-disabled={isDisabled || undefined}
      aria-label={`${card.label}、${KIND_LABELS[card.kind]}${stateLabel}`}
      aria-pressed={isInteractive ? state === 'selected' : undefined}
      className={`wildcard-card wildcard-card--${card.kind} wildcard-card--${state}`}
      data-card-id={card.id}
      data-state={state}
      onClick={isDisabled ? undefined : onSelect}
      onKeyDown={isInteractive ? handleKeyDown : undefined}
      role={isInteractive ? 'button' : undefined}
      tabIndex={isInteractive && !isDisabled ? 0 : undefined}
    >
      <span
        className="wildcard-card__pip wildcard-card__pip--top"
        aria-hidden="true"
      >
        {KIND_MARKS[card.kind]}
      </span>

      {CARD_MOTIFS[card.id] && (
        <span className="wildcard-card__motif" aria-hidden="true">
          {CARD_MOTIFS[card.id]}
        </span>
      )}

      <h2 className="wildcard-card__label" data-label={card.label}>
        {card.label}
      </h2>

      <span
        className="wildcard-card__pip wildcard-card__pip--bottom"
        aria-hidden="true"
      >
        {KIND_MARKS[card.kind]}
      </span>
    </article>
  );
}
