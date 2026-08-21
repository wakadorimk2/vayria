import { useCallback, useState, type FormEvent } from 'react';
import { VrmStage } from './avatar/VrmStage';
import { useAudioLipSync } from './audio/useAudioLipSync';
import { CardGamePrototype } from './cards/CardGamePrototype';
import { useCardGamePrototype } from './cards/useCardGamePrototype';
import { useAutonomousTalk } from './conversation/useAutonomousTalk';
import { useConversation } from './conversation/useConversation';

const STATUS_LABELS = {
  idle: '話しかけてください。',
  thinking: '考えています…',
  synthesizing: '返答音声を作っています…',
  speaking: '話しています。',
  error: '処理を完了できませんでした。',
} as const;

export default function App() {
  const [input, setInput] = useState('');
  const [isAvatarReady, setIsAvatarReady] = useState(false);
  const [isMuted, setIsMuted] = useState(false);
  const cardGame = useCardGamePrototype();
  const { acceptReply, beginReply, zones } = cardGame;
  const { mouthOpen, play, prepare, stop } = useAudioLipSync();
  const {
    cancelAutonomous,
    emotion,
    error,
    isBusy,
    isManualBusy,
    reply,
    sendAutonomous,
    sendManual,
    status,
  } = useConversation(play, stop, { historyLimit: 6, isMuted });
  const trimmedInput = input.trim();

  const readCardContext = useCallback(
    () => ({
      brainCardIds: zones.brain.map((card) => card.id),
      forcedCardId: zones.forcedCardId,
    }),
    [zones.brain, zones.forcedCardId],
  );

  const startAutonomous = useCallback(async () => {
    beginReply();
    prepare();
    return sendAutonomous(readCardContext(), acceptReply);
  }, [
    acceptReply,
    beginReply,
    prepare,
    readCardContext,
    sendAutonomous,
  ]);

  useAutonomousTalk({
    cancelAutonomous,
    isBusy,
    isMuted,
    isReady: isAvatarReady,
    startAutonomous,
  });

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedInput || isManualBusy) return;
    beginReply();
    if (!isMuted) prepare();
    setInput('');
    void sendManual(trimmedInput, readCardContext(), acceptReply);
  };

  const handleMuteToggle = () => {
    if (isMuted) {
      prepare();
    } else {
      stop();
    }
    setIsMuted(!isMuted);
  };

  const handleAvatarReady = useCallback(() => {
    prepare();
    setIsAvatarReady(true);
  }, [prepare]);

  return (
    <main className="app-shell">
      <header className="app-title">
        <span>Wildcard</span>
        <button
          aria-label={isMuted ? '音声をオンにする' : '音声をミュートする'}
          aria-pressed={isMuted}
          className="mute-button"
          onClick={handleMuteToggle}
          title={isMuted ? 'Muted' : 'Autonomous talk active'}
          type="button"
        >
          <span aria-hidden="true">{isMuted ? '🔇' : '🔊'}</span>
        </button>
      </header>

      <section className="avatar-area" aria-label="VRM character">
        <VrmStage
          emotion={emotion}
          mouthOpen={mouthOpen}
          onReady={handleAvatarReady}
        />
        <CardGamePrototype
          game={cardGame}
          isInteractionLocked={isBusy}
        />
      </section>

      <section className="conversation" aria-label="Character conversation">
        <div className="conversation-copy" aria-live="polite">
          {reply && <p className="reply">{reply}</p>}
          <p className="status">
            {isMuted && status === 'idle'
              ? 'ミュート中です。テキスト会話は利用できます。'
              : STATUS_LABELS[status]}
          </p>
          {error && (
            <p className="conversation-error" role="alert">
              {error}
            </p>
          )}
        </div>

        <form className="message-form" onSubmit={handleSubmit}>
          <label className="visually-hidden" htmlFor="message-input">
            キャラクターへ送るメッセージ
          </label>
          <input
            autoComplete="off"
            disabled={isManualBusy}
            id="message-input"
            maxLength={1000}
            onChange={(event) => setInput(event.target.value)}
            placeholder="メッセージを入力"
            type="text"
            value={input}
          />
          <button disabled={!trimmedInput || isManualBusy} type="submit">
            Send
          </button>
        </form>
      </section>
    </main>
  );
}
