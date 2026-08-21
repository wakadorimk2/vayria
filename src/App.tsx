import { useState, type FormEvent } from 'react';
import { VrmStage } from './avatar/VrmStage';
import { useAudioLipSync } from './audio/useAudioLipSync';
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
  const { mouthOpen, play, prepare } = useAudioLipSync();
  const { error, isBusy, reply, send, status } = useConversation(play);
  const trimmedInput = input.trim();

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!trimmedInput || isBusy) return;
    prepare();
    setInput('');
    void send(trimmedInput);
  };

  return (
    <main className="app-shell">
      <header className="app-title">
        <span>Wildcard</span>
      </header>

      <section className="avatar-area" aria-label="VRM character">
        <VrmStage mouthOpen={mouthOpen} />
      </section>

      <section className="conversation" aria-label="Character conversation">
        <div className="conversation-copy" aria-live="polite">
          {reply && <p className="reply">{reply}</p>}
          <p className="status">{STATUS_LABELS[status]}</p>
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
            disabled={isBusy}
            id="message-input"
            maxLength={1000}
            onChange={(event) => setInput(event.target.value)}
            placeholder="メッセージを入力"
            type="text"
            value={input}
          />
          <button disabled={!trimmedInput || isBusy} type="submit">
            Send
          </button>
        </form>
      </section>
    </main>
  );
}
