import { cardPool } from './cardPool';
import {
  WildcardCard,
  type CardKind,
  type CardState,
} from './WildcardCard';

const KIND_LEGEND: ReadonlyArray<{ kind: CardKind; label: string }> = [
  { kind: 'concept', label: 'concept' },
  { kind: 'mood', label: 'mood' },
  { kind: 'effect', label: 'effect' },
];

const STATE_PREVIEWS: ReadonlyArray<{
  state: CardState;
  label: string;
  cardIndex: number;
}> = [
  { state: 'normal', label: 'normal', cardIndex: 0 },
  { state: 'selected', label: 'selected', cardIndex: 1 },
  { state: 'active', label: 'active', cardIndex: 5 },
  { state: 'disabled', label: 'disabled', cardIndex: 4 },
];

export default function CardsPreviewPage() {
  return (
    <main className="cards-preview">
      <div className="cards-preview__content">
        <header className="cards-preview__header">
          <div>
            <p className="cards-preview__eyebrow">WILDCARD / MENTAL FRAGMENTS</p>
            <h1>Card Pool</h1>
            <p className="cards-preview__intro">
              頭の片隅に浮かぶ、名前のついた断片。
            </p>
          </div>

          <div className="cards-preview__legend" aria-label="Card kinds">
            {KIND_LEGEND.map(({ kind, label }) => (
              <span className={`kind-key kind-key--${kind}`} key={kind}>
                <span className="kind-key__mark" aria-hidden="true" />
                {label}
              </span>
            ))}
          </div>
        </header>

        <section aria-labelledby="card-pool-heading">
          <div className="cards-preview__section-heading">
            <h2 id="card-pool-heading">Pool</h2>
            <span>{cardPool.length.toString().padStart(2, '0')} signals</span>
          </div>

          <div className="card-grid">
            {cardPool.map((card) => (
              <WildcardCard card={card} key={card.id} />
            ))}
          </div>
        </section>

        <section
          aria-labelledby="card-states-heading"
          className="cards-preview__states"
        >
          <div className="cards-preview__section-heading">
            <h2 id="card-states-heading">Visual states</h2>
            <span>appearance only</span>
          </div>

          <div className="state-grid">
            {STATE_PREVIEWS.map(({ state, label, cardIndex }) => (
              <figure className="state-preview" key={state}>
                <WildcardCard card={cardPool[cardIndex]} state={state} />
                <figcaption>{label}</figcaption>
              </figure>
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
