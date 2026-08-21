import './cards.css';

export type CardKind = 'concept' | 'mood' | 'effect';

export type CardState = 'normal' | 'selected' | 'active' | 'disabled';

export interface WildcardCardData {
  id: string;
  label: string;
  kind: CardKind;
}

export interface WildcardCardProps {
  card: WildcardCardData;
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
  state = 'normal',
}: WildcardCardProps) {
  return (
    <article
      aria-disabled={state === 'disabled' || undefined}
      aria-label={`${card.label}、${KIND_LABELS[card.kind]}`}
      className={`wildcard-card wildcard-card--${card.kind} wildcard-card--${state}`}
      data-card-id={card.id}
      data-state={state}
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
