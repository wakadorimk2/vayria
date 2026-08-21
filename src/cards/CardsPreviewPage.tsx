import { cardPool } from './cardPool';
import { WildcardCard } from './WildcardCard';

export default function CardsPreviewPage() {
  return (
    <main className="cards-preview">
      <div className="cards-preview__content">
        <header className="cards-preview__header">
          <h1>Card Pool</h1>
        </header>

        <section aria-label="Wildcard cards">
          <div className="card-grid">
            {cardPool.map((card) => (
              <WildcardCard card={card} key={card.id} />
            ))}
          </div>
        </section>
      </div>
    </main>
  );
}
