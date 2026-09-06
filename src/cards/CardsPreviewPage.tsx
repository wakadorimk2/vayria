import { CardBehaviorPreview } from './CardBehaviorPreview';
import { CardArtwork } from './CardArtwork';
import { cardPool } from './cardPool';
import './salon-gallery.css';
import { SalonPreviewPage } from './SalonPreviewPage';

export default function CardsPreviewPage() {
  if (new URLSearchParams(window.location.search).get('view') === 'salon') {
    return <SalonPreviewPage />;
  }
  if (new URLSearchParams(window.location.search).get('view') === 'artwork') {
    return (
      <main className="salon-artwork-gallery">
        <h1>Vayria — Salon cards</h1>
        <p>全18種・線画レビュー / 左：手札 / 右：脳内</p>
        <div className="salon-artwork-gallery__grid">
          {cardPool.map((card) => (
            <section key={card.id}>
              <div className="salon-artwork-gallery__pair">
                <div><CardArtwork cardId={card.id} /></div>
                <div><CardArtwork cardId={card.id} /></div>
              </div>
              <h2>{card.label}</h2>
            </section>
          ))}
        </div>
      </main>
    );
  }
  return (
    <main className="cards-preview">
      <div className="cards-preview__content">
        <CardBehaviorPreview />
      </div>
    </main>
  );
}
