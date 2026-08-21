import { WildcardCard } from './WildcardCard';
import type {
  CardGamePrototypeController,
  CardZone,
} from './useCardGamePrototype';

interface CardGamePrototypeProps {
  game: CardGamePrototypeController;
}

export function CardGamePrototype({ game }: CardGamePrototypeProps) {
  const {
    maxStamina,
    resetTurn,
    selectCard,
    selectedBrainCardId,
    selectedHandCardId,
    swapSelectedCards,
    zones,
  } = game;
  const isSpent = zones.stamina === 0;
  const isSwapReady = Boolean(
    selectedBrainCardId && selectedHandCardId && !isSpent,
  );

  const selectionHint = isSpent
    ? 'このターンは操作済み'
    : isSwapReady
      ? '選んだ2枚を交換できます'
      : selectedBrainCardId || selectedHandCardId
        ? 'もう一方から1枚選択'
        : '手札と脳内から1枚ずつ選択';

  const renderCards = (zone: CardZone) => {
    const selectedId =
      zone === 'brain' ? selectedBrainCardId : selectedHandCardId;
    return zones[zone].map((card) => (
      <WildcardCard
        card={card}
        key={card.id}
        onSelect={() => selectCard(zone, card.id)}
        state={
          isSpent ? 'disabled' : selectedId === card.id ? 'selected' : 'normal'
        }
      />
    ));
  };

  return (
    <div className="card-prototype" aria-label="Brain and hand cards">
      <section className="card-zone card-zone--brain" aria-label="脳内">
        <header className="card-zone__header">
          <span className="card-zone__eyebrow">CHARACTER</span>
          <h2>脳内</h2>
        </header>
        <div className="card-zone__cards">{renderCards('brain')}</div>
      </section>

      <section className="card-zone card-zone--hand" aria-label="手札">
        <header className="card-zone__header card-zone__header--hand">
          <div>
            <span className="card-zone__eyebrow">PLAYER</span>
            <h2>手札</h2>
          </div>
          <div className="card-zone__turn-status">
            <span
              className={`stamina stamina--${isSpent ? 'spent' : 'ready'}`}
              aria-label={`stamina ${zones.stamina} / ${maxStamina}`}
            >
              <span aria-hidden="true">{isSpent ? '○' : '●'}</span>{' '}
              {zones.stamina} / {maxStamina}
            </span>
            {import.meta.env.DEV && (
              <button
                className="reset-turn-button"
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
          {isSwapReady && (
            <button
              className="swap-button"
              onClick={swapSelectedCards}
              type="button"
            >
              Swap
            </button>
          )}
        </div>
      </section>
    </div>
  );
}
