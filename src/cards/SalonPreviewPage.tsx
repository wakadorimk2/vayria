import { useState } from 'react';
import { VrmStage } from '../avatar/VrmStage';
import type { Attention } from '../performer/types';
import { CardGamePrototype } from './CardGamePrototype';
import { useCardGamePrototype } from './useCardGamePrototype';
import { getExhibitionUiPhasePresentation, type ExhibitionUiPhase } from '../exhibition/exhibitionUi';

const readAttention = (): Attention => ({
  target: 'viewer', strength: 0, confidence: 0, updatedAt: 0, position: null,
});
const sampleReply = '雨の日は、窓のそばで音を聞くのが好き。あなたは、どんなふうに過ごす？';

export function SalonPreviewPage() {
  const game = useCardGamePrototype();
  const [phase, setPhase] = useState<ExhibitionUiPhase>('idle');
  const [selected, setSelected] = useState(false);
  const [longReply, setLongReply] = useState(false);
  const presentation = getExhibitionUiPhasePresentation(phase);
  return (
    <main className="app-shell" data-app-mode="exhibition" data-exhibition-ui-mode="candidate"
      data-exhibition-ui-phase={phase} data-exhibition-state={selected ? 'selecting' : phase === 'speaking' ? 'reacting' : 'idle'}>
      <nav className="salon-preview-controls" aria-label="サンプル表示">
        <span>サンプル表示・実会話ではありません</span>
        <button onClick={() => { game.resetTurn(); game.clearReplyPresentation(); setPhase('idle'); }}>待機</button>
        <button onClick={() => { game.presentReply(['chicken', 'rain']); setPhase('speaking'); setLongReply(false); }}>返答</button>
        <button onClick={() => { game.presentReply(['chicken', 'rain']); setPhase('speaking'); setLongReply(true); }}>長い返答</button>
      </nav>
      <section className="avatar-area" aria-label="VRM character">
        <VrmStage attentionReader={readAttention} emotion="neutral" mouthOpen={0}
          isExhibitionMode isCandidateExhibitionUi />
        <CardGamePrototype game={game} exhibitionUiMode="candidate" onSelectionActiveChange={setSelected} />
      </section>
      <section className="conversation" aria-label="返答サンプル" tabIndex={0}>
        <div className="conversation-copy" aria-live="polite">
          <p className="exhibition-phase" data-phase={phase} role="status">
            <span className="exhibition-phase__mark" aria-hidden="true">{presentation.mark}</span>
            <span className="exhibition-phase__label">{presentation.label}</span>
          </p>
          {phase === 'speaking' && <p className="reply">{longReply ? sampleReply.repeat(8) : sampleReply}</p>}
        </div>
      </section>
    </main>
  );
}
