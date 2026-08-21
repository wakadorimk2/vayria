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
  concept: 'CONCEPT',
  mood: 'MOOD',
  effect: 'EFFECT',
};

export function WildcardCard({
  card,
  state = 'normal',
}: WildcardCardProps) {
  return (
    <article
      aria-disabled={state === 'disabled' || undefined}
      aria-label={`${card.label}、${KIND_LABELS[card.kind].toLowerCase()}`}
      className={`wildcard-card wildcard-card--${card.kind} wildcard-card--${state}`}
      data-card-id={card.id}
      data-state={state}
    >
      <span className="wildcard-card__pattern" aria-hidden="true" />
      <span className="wildcard-card__corner" aria-hidden="true" />

      <header className="wildcard-card__meta">
        <span className="wildcard-card__kind-mark" aria-hidden="true" />
        <span className="wildcard-card__kind-label">
          {KIND_LABELS[card.kind]}
        </span>
      </header>

      <h2 className="wildcard-card__label">{card.label}</h2>

      <footer className="wildcard-card__footer" aria-hidden="true">
        <span className="wildcard-card__baseline" />
        <span className="wildcard-card__state-mark" />
      </footer>
    </article>
  );
}
